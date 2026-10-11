BEGIN;

CREATE TABLE accounting_assistant_task (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  legal_entity_id uuid NOT NULL REFERENCES legal_entity(id) ON DELETE CASCADE,
  task_key text NOT NULL,
  category text NOT NULL
    CHECK(category IN (
      'TAX','FNS','ENS','BANK','PRIMARY_DOCS','PAYROLL',
      'INVENTORY','RECONCILIATION','PERIOD_CLOSE','NPD','SETUP'
    )),
  severity text NOT NULL DEFAULT 'INFO'
    CHECK(severity IN ('INFO','WARNING','CRITICAL')),
  status text NOT NULL DEFAULT 'OPEN'
    CHECK(status IN ('OPEN','IN_PROGRESS','DONE','DISMISSED')),
  title text NOT NULL,
  description text NOT NULL,
  action_code text,
  action_href text,
  source_type text,
  source_id uuid,
  due_at timestamptz,
  amount_minor bigint CHECK(amount_minor IS NULL OR amount_minor>=0),
  currency char(3) NOT NULL DEFAULT 'RUB',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolved_by_membership_id uuid
    REFERENCES tenant_membership(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,legal_entity_id,task_key)
);

CREATE INDEX accounting_assistant_task_open_idx
  ON accounting_assistant_task(
    tenant_id,legal_entity_id,status,severity,due_at
  );

CREATE OR REPLACE FUNCTION corebiz_accounting_assistant_task_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
BEGIN
  IF NOT EXISTS(
    SELECT 1
    FROM legal_entity le
    WHERE le.tenant_id=NEW.tenant_id
      AND le.id=NEW.legal_entity_id
  ) THEN
    RAISE EXCEPTION 'ACCOUNTING_ASSISTANT_LEGAL_ENTITY_MISMATCH'
      USING ERRCODE='23514';
  END IF;

  IF NEW.status IN ('DONE','DISMISSED') THEN
    IF NEW.resolved_by_membership_id IS NULL OR NEW.resolved_at IS NULL THEN
      RAISE EXCEPTION 'ACCOUNTING_ASSISTANT_RESOLUTION_AUDIT_REQUIRED'
        USING ERRCODE='23514';
    END IF;
  ELSE
    NEW.resolved_by_membership_id=NULL;
    NEW.resolved_at=NULL;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER accounting_assistant_task_guard_v1
BEFORE INSERT OR UPDATE
ON accounting_assistant_task
FOR EACH ROW EXECUTE FUNCTION corebiz_accounting_assistant_task_guard();

ALTER TABLE accounting_assistant_task ENABLE ROW LEVEL SECURITY;

CREATE POLICY accounting_assistant_task_isolation
  ON accounting_assistant_task
  USING (
    tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  )
  WITH CHECK (
    tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
  );

CREATE TRIGGER accounting_assistant_task_tenant_refs_v1
BEFORE INSERT OR UPDATE ON accounting_assistant_task
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'legal_entity_id','legal_entity',
  'resolved_by_membership_id','tenant_membership'
);

COMMIT;
