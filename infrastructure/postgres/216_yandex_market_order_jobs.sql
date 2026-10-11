BEGIN;
ALTER TABLE channel_sync_job DROP CONSTRAINT IF EXISTS channel_sync_job_provider_check;
ALTER TABLE channel_sync_job ADD CONSTRAINT channel_sync_job_provider_check
 CHECK(provider IN ('OZON','WILDBERRIES','YANDEX_MARKET'));

CREATE OR REPLACE FUNCTION corebiz_schedule_fbs_stock_poll()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE created integer:=0;
BEGIN
 IF NOT pg_try_advisory_xact_lock(hashtext('corebiz-fbs-channel-poll')) THEN RETURN 0; END IF;
 WITH ready AS (
  SELECT c.id,c.tenant_id,c.provider,c.last_synced_at
  FROM channel_connection c
  WHERE c.status='ACTIVE' AND c.provider IN ('OZON','WILDBERRIES','YANDEX_MARKET')
    AND c.credentials_ciphertext IS NOT NULL
    AND EXISTS(SELECT 1 FROM channel_stock_listing l
      WHERE l.tenant_id=c.tenant_id AND l.connection_id=c.id
        AND l.publish_enabled AND l.enabled)
    AND NOT EXISTS(
      SELECT 1 FROM channel_sync_job j WHERE j.tenant_id=c.tenant_id
        AND j.connection_id=c.id
        AND (j.status IN ('PENDING','RUNNING')
         OR (j.status='FAILED' AND j.attempts<8 AND
             (j.retry_at IS NULL OR j.retry_at>now()))
         OR j.created_at>now()-interval '90 seconds')
    )
  ORDER BY c.last_synced_at NULLS FIRST LIMIT 8
 ), jobs AS (
  INSERT INTO channel_sync_job(tenant_id,connection_id,provider,period_from,period_to)
  SELECT tenant_id,id,provider,
     greatest(now()-interval '24 hours',
       coalesce(last_synced_at-interval '10 minutes',now()-interval '24 hours')),
     now() FROM ready RETURNING id
 )
 SELECT count(*)::integer INTO created FROM jobs;
 RETURN created;
END;$$;
REVOKE ALL ON FUNCTION corebiz_schedule_fbs_stock_poll() FROM PUBLIC;
COMMIT;