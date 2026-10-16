BEGIN;

-- Preserve one active privacy export per tenant even under concurrent clicks.
-- Fail installation with a clear diagnostic if historical duplicates exist.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM tenant_export_job
    WHERE status IN ('PENDING','PROCESSING')
    GROUP BY tenant_id HAVING count(*)>1
  ) THEN
    RAISE EXCEPTION
      'TENANT_EXPORT_DUPLICATES: resolve duplicate active export jobs before migration 254';
  END IF;
END;
$$;

CREATE UNIQUE INDEX tenant_export_one_active_idx
  ON tenant_export_job(tenant_id)
  WHERE status IN ('PENDING','PROCESSING');

COMMIT;
