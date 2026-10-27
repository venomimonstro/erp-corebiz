BEGIN;

-- Background integrations must respect the same commercial tenant lifecycle as
-- public HTTP surfaces. Claims for suspended/cancelled/expired tenants remain
-- queued and are not allowed to call external providers. Data export and SaaS
-- payment reconciliation are intentionally excluded so a customer can recover
-- access and export data while the workspace is read-only.

CREATE OR REPLACE FUNCTION public.corebiz_claim_domain_event()
RETURNS TABLE(
  id uuid,tenant_id uuid,event_name text,entity_type text,entity_id uuid,
  actor_user_id uuid,actor_membership_id uuid,payload jsonb,depth integer,
  attempts integer,locked_at timestamptz
)
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $$
  WITH chosen AS (
    SELECT e.id
    FROM public.domain_event_outbox e
    WHERE public.corebiz_tenant_is_operational(e.tenant_id)
      AND e.attempts<5
      AND (
        (e.status IN ('PENDING','FAILED') AND e.next_attempt_at<=now())
        OR (
          e.status='PROCESSING'
          AND (
            e.locked_at IS NULL
            OR e.locked_at<now()-interval '15 minutes'
          )
        )
      )
    ORDER BY e.created_at,e.id
    FOR UPDATE OF e SKIP LOCKED
    LIMIT 1
  )
  UPDATE public.domain_event_outbox e
  SET status='PROCESSING',locked_at=now(),attempts=e.attempts+1
  FROM chosen
  WHERE e.id=chosen.id
  RETURNING e.id,e.tenant_id,e.event_name,e.entity_type,e.entity_id,
    e.actor_user_id,e.actor_membership_id,e.payload,e.depth,e.attempts,e.locked_at
$$;

CREATE OR REPLACE FUNCTION public.corebiz_claim_marketing_sync_job()
RETURNS TABLE(
  job_id uuid,tenant_id uuid,connection_id uuid,provider text,
  period_from date,period_to date,report_name text,attempts integer,
  credentials_ciphertext text,client_login text
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $$
DECLARE
  v_job public.marketing_sync_job%ROWTYPE;
BEGIN
  SELECT j.*
  INTO v_job
  FROM public.marketing_sync_job j
  JOIN public.marketing_connection c
    ON c.id=j.connection_id AND c.tenant_id=j.tenant_id
  WHERE public.corebiz_tenant_is_operational(j.tenant_id)
    AND j.status IN ('PENDING','WAITING_PROVIDER','FAILED')
    AND (j.retry_at IS NULL OR j.retry_at<=now())
    AND j.attempts<8
    AND c.status='ACTIVE'
    AND c.credentials_ciphertext IS NOT NULL
  ORDER BY j.created_at
  FOR UPDATE OF j SKIP LOCKED
  LIMIT 1;

  IF NOT FOUND THEN RETURN; END IF;

  UPDATE public.marketing_sync_job
  SET status='RUNNING',
      attempts=attempts+1,
      started_at=COALESCE(started_at,now()),
      retry_at=NULL
  WHERE id=v_job.id;

  RETURN QUERY
  SELECT v_job.id,v_job.tenant_id,v_job.connection_id,v_job.provider,
    v_job.period_from,v_job.period_to,v_job.report_name,v_job.attempts+1,
    c.credentials_ciphertext,c.client_login
  FROM public.marketing_connection c
  WHERE c.id=v_job.connection_id
    AND c.tenant_id=v_job.tenant_id
    AND c.status='ACTIVE'
    AND c.credentials_ciphertext IS NOT NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.corebiz_claim_channel_sync_job()
RETURNS TABLE(
  job_id uuid,tenant_id uuid,connection_id uuid,provider text,
  period_from timestamptz,period_to timestamptz,cursor jsonb,attempts integer,
  credentials_ciphertext text,config jsonb
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $$
DECLARE
  v_job public.channel_sync_job%ROWTYPE;
BEGIN
  SELECT j.*
  INTO v_job
  FROM public.channel_sync_job j
  JOIN public.channel_connection c
    ON c.id=j.connection_id AND c.tenant_id=j.tenant_id
  WHERE public.corebiz_tenant_is_operational(j.tenant_id)
    AND (
      j.status IN ('PENDING','FAILED')
      OR (
        j.status='RUNNING'
        AND j.started_at<now()-interval '10 minutes'
      )
    )
    AND (j.retry_at IS NULL OR j.retry_at<=now())
    AND j.attempts<8
    AND c.status<>'DISABLED'
    AND c.credentials_ciphertext IS NOT NULL
  ORDER BY j.created_at
  FOR UPDATE OF j SKIP LOCKED
  LIMIT 1;

  IF NOT FOUND THEN RETURN; END IF;

  UPDATE public.channel_sync_job
  SET status='RUNNING',attempts=attempts+1,started_at=now(),
      retry_at=now()+interval '10 minutes',last_error=NULL
  WHERE id=v_job.id;

  RETURN QUERY
  SELECT v_job.id,v_job.tenant_id,v_job.connection_id,v_job.provider,
    v_job.period_from,v_job.period_to,v_job.cursor,v_job.attempts+1,
    c.credentials_ciphertext,c.config
  FROM public.channel_connection c
  WHERE c.id=v_job.connection_id
    AND c.tenant_id=v_job.tenant_id
    AND c.status<>'DISABLED'
    AND c.credentials_ciphertext IS NOT NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.corebiz_claim_stock_dirty()
RETURNS TABLE(tenant_id uuid,warehouse_id uuid,sku_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $$
BEGIN
  RETURN QUERY
  WITH candidate AS (
    SELECT d.tenant_id,d.warehouse_id,d.sku_id
    FROM public.channel_stock_dirty d
    WHERE public.corebiz_tenant_is_operational(d.tenant_id)
    ORDER BY d.queued_at
    FOR UPDATE OF d SKIP LOCKED
    LIMIT 1
  )
  DELETE FROM public.channel_stock_dirty d
  USING candidate c
  WHERE d.tenant_id=c.tenant_id
    AND d.warehouse_id=c.warehouse_id
    AND d.sku_id=c.sku_id
  RETURNING d.tenant_id,d.warehouse_id,d.sku_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.corebiz_claim_stock_target()
RETURNS TABLE(
  tenant_id uuid,listing_id uuid,connection_id uuid,provider text,
  external_offer_id text,external_stock_id text,external_warehouse_id text,
  target_units integer,generation bigint,credentials_ciphertext text,config jsonb
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $$
BEGIN
  RETURN QUERY
  WITH candidate AS (
    SELECT t.tenant_id,t.listing_id
    FROM public.channel_stock_target t
    JOIN public.channel_stock_listing l
      ON l.tenant_id=t.tenant_id AND l.id=t.listing_id
    JOIN public.channel_connection c
      ON c.tenant_id=l.tenant_id AND c.id=l.connection_id
    WHERE public.corebiz_tenant_is_operational(t.tenant_id)
      AND (
        t.status IN ('PENDING','RETRY')
        OR (t.status='SENDING' AND t.lease_until<now())
      )
      AND (t.next_attempt_at IS NULL OR t.next_attempt_at<=now())
      AND t.attempts<8
      AND c.credentials_ciphertext IS NOT NULL
      AND c.status<>'DISABLED'
    ORDER BY CASE WHEN t.target_units=0 THEN 0 ELSE 1 END,t.updated_at
    FOR UPDATE OF t SKIP LOCKED
    LIMIT 1
  ), claimed AS (
    UPDATE public.channel_stock_target t
    SET status='SENDING',lease_until=now()+interval '90 seconds',
        attempts=t.attempts+1,updated_at=now()
    FROM candidate k
    WHERE t.tenant_id=k.tenant_id AND t.listing_id=k.listing_id
    RETURNING t.tenant_id,t.listing_id,t.target_units,t.generation
  )
  SELECT q.tenant_id,q.listing_id,c.id,c.provider,m.external_offer_id,
    l.external_stock_id,l.external_warehouse_id,q.target_units,q.generation,
    c.credentials_ciphertext,c.config
  FROM claimed q
  JOIN public.channel_stock_listing l
    ON l.tenant_id=q.tenant_id AND l.id=q.listing_id
  JOIN public.channel_product_mapping m
    ON m.tenant_id=l.tenant_id AND m.id=l.mapping_id
  JOIN public.channel_connection c
    ON c.tenant_id=l.tenant_id AND c.id=l.connection_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.corebiz_schedule_fbs_stock_poll()
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $$
DECLARE
  created integer:=0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('corebiz-fbs-channel-poll')) THEN
    RETURN 0;
  END IF;

  WITH ready AS (
    SELECT c.id,c.tenant_id,c.provider,c.last_synced_at
    FROM public.channel_connection c
    WHERE public.corebiz_tenant_is_operational(c.tenant_id)
      AND c.status='ACTIVE'
      AND c.provider IN ('OZON','WILDBERRIES','YANDEX_MARKET')
      AND c.credentials_ciphertext IS NOT NULL
      AND EXISTS(
        SELECT 1 FROM public.channel_stock_listing l
        WHERE l.tenant_id=c.tenant_id AND l.connection_id=c.id
          AND l.publish_enabled AND l.enabled
      )
      AND NOT EXISTS(
        SELECT 1 FROM public.channel_sync_job j
        WHERE j.tenant_id=c.tenant_id AND j.connection_id=c.id
          AND (
            j.status IN ('PENDING','RUNNING')
            OR (
              j.status='FAILED' AND j.attempts<8
              AND (j.retry_at IS NULL OR j.retry_at>now())
            )
            OR j.created_at>now()-interval '90 seconds'
          )
      )
    ORDER BY c.last_synced_at NULLS FIRST
    LIMIT 8
  ), jobs AS (
    INSERT INTO public.channel_sync_job(
      tenant_id,connection_id,provider,period_from,period_to
    )
    SELECT tenant_id,id,provider,
      greatest(
        now()-interval '24 hours',
        coalesce(last_synced_at-interval '10 minutes',now()-interval '24 hours')
      ),
      now()
    FROM ready
    RETURNING id
  )
  SELECT count(*)::integer INTO created FROM jobs;

  RETURN created;
END;
$$;

CREATE OR REPLACE FUNCTION public.corebiz_claim_offline_conversion_job()
RETURNS TABLE(
  job_id uuid,tenant_id uuid,connection_id uuid,counter_id bigint,target text,
  credentials_ciphertext text,conversion_type text,conversion_id uuid,yclid text,
  occurred_at timestamptz,value_minor bigint,currency char(3),attempts integer
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $$
DECLARE
  v_job public.offline_conversion_job%ROWTYPE;
BEGIN
  SELECT j.*
  INTO v_job
  FROM public.offline_conversion_job j
  JOIN public.offline_conversion_connection c
    ON c.id=j.connection_id AND c.tenant_id=j.tenant_id
  WHERE public.corebiz_tenant_is_operational(j.tenant_id)
    AND j.status IN ('PENDING','FAILED')
    AND (j.retry_at IS NULL OR j.retry_at<=now())
    AND j.attempts<8
    AND c.status<>'DISABLED'
  ORDER BY j.created_at
  FOR UPDATE OF j SKIP LOCKED
  LIMIT 1;

  IF NOT FOUND THEN RETURN; END IF;

  UPDATE public.offline_conversion_job
  SET attempts=attempts+1,retry_at=now()+interval '5 minutes'
  WHERE id=v_job.id;

  RETURN QUERY
  SELECT v_job.id,v_job.tenant_id,v_job.connection_id,c.counter_id,
    v_job.target,c.credentials_ciphertext,v_job.conversion_type,
    v_job.conversion_id,v_job.yclid,v_job.occurred_at,v_job.value_minor,
    v_job.currency,v_job.attempts+1
  FROM public.offline_conversion_connection c
  WHERE c.id=v_job.connection_id
    AND c.tenant_id=v_job.tenant_id
    AND c.status<>'DISABLED';
END;
$$;

CREATE OR REPLACE FUNCTION public.corebiz_claim_offline_conversion_status_job()
RETURNS TABLE(
  job_id uuid,tenant_id uuid,connection_id uuid,counter_id bigint,
  credentials_ciphertext text,provider_upload_id text
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $$
DECLARE
  v_job public.offline_conversion_job%ROWTYPE;
BEGIN
  SELECT j.*
  INTO v_job
  FROM public.offline_conversion_job j
  JOIN public.offline_conversion_connection c
    ON c.id=j.connection_id AND c.tenant_id=j.tenant_id
  WHERE public.corebiz_tenant_is_operational(j.tenant_id)
    AND j.status='UPLOADED'
    AND j.provider_upload_id IS NOT NULL
    AND (j.retry_at IS NULL OR j.retry_at<=now())
    AND c.status<>'DISABLED'
  ORDER BY j.uploaded_at NULLS FIRST,j.created_at
  FOR UPDATE OF j SKIP LOCKED
  LIMIT 1;

  IF NOT FOUND THEN RETURN; END IF;

  UPDATE public.offline_conversion_job
  SET retry_at=now()+interval '2 minutes'
  WHERE id=v_job.id;

  RETURN QUERY
  SELECT v_job.id,v_job.tenant_id,v_job.connection_id,c.counter_id,
    c.credentials_ciphertext,v_job.provider_upload_id
  FROM public.offline_conversion_connection c
  WHERE c.id=v_job.connection_id
    AND c.tenant_id=v_job.tenant_id
    AND c.status<>'DISABLED';
END;
$$;

REVOKE ALL ON FUNCTION public.corebiz_claim_domain_event() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.corebiz_claim_marketing_sync_job() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.corebiz_claim_channel_sync_job() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.corebiz_claim_stock_dirty() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.corebiz_claim_stock_target() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.corebiz_schedule_fbs_stock_poll() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.corebiz_claim_offline_conversion_job() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.corebiz_claim_offline_conversion_status_job() FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='corebiz_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.corebiz_claim_domain_event() TO corebiz_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.corebiz_claim_marketing_sync_job() TO corebiz_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.corebiz_claim_channel_sync_job() TO corebiz_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.corebiz_claim_stock_dirty() TO corebiz_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.corebiz_claim_stock_target() TO corebiz_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.corebiz_schedule_fbs_stock_poll() TO corebiz_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.corebiz_claim_offline_conversion_job() TO corebiz_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.corebiz_claim_offline_conversion_status_job() TO corebiz_app';
  END IF;
END;
$$;

COMMIT;
