BEGIN;

CREATE TABLE payroll_statement_review (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  statement_kind text NOT NULL
    CHECK (statement_kind IN ('DANCE_TRAINER','SERVICE_EMPLOYEE')),
  statement_id uuid NOT NULL,
  employee_resource_id uuid NOT NULL
    REFERENCES service_resource(id) ON DELETE RESTRICT,
  reviewer_membership_id uuid
    REFERENCES tenant_membership(id) ON DELETE SET NULL,
  review_status text NOT NULL DEFAULT 'PENDING'
    CHECK (
      review_status IN (
        'PENDING','ACKNOWLEDGED','DISPUTED','RESOLVED','WAIVED'
      )
    ),
  statement_total_minor_snapshot bigint NOT NULL DEFAULT 0
    CHECK (statement_total_minor_snapshot >= 0),
  currency char(3) NOT NULL DEFAULT 'RUB',
  employee_comment text,
  manager_comment text,
  acknowledged_at timestamptz,
  disputed_at timestamptz,
  resolved_at timestamptz,
  resolved_by_membership_id uuid
    REFERENCES tenant_membership(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,statement_kind,statement_id),
  UNIQUE (tenant_id,id)
);

CREATE INDEX payroll_statement_review_status_idx
  ON payroll_statement_review(
    tenant_id,review_status,statement_kind,employee_resource_id,updated_at
  );

CREATE TABLE payroll_statement_review_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  review_id uuid NOT NULL
    REFERENCES payroll_statement_review(id) ON DELETE CASCADE,
  event_type text NOT NULL
    CHECK (
      event_type IN (
        'CREATED','ACKNOWLEDGED','DISPUTED','RESOLVED',
        'WAIVED','INVALIDATED'
      )
    ),
  actor_membership_id uuid
    REFERENCES tenant_membership(id) ON DELETE SET NULL,
  previous_status text,
  new_status text NOT NULL,
  comment text,
  statement_total_minor_snapshot bigint NOT NULL
    CHECK (statement_total_minor_snapshot >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX payroll_statement_review_event_review_idx
  ON payroll_statement_review_event(tenant_id,review_id,created_at,id);

CREATE OR REPLACE FUNCTION corebiz_payroll_statement_review_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
DECLARE
  v_employee uuid;
  v_total bigint;
  v_currency char(3);
BEGIN
  IF NEW.statement_kind='DANCE_TRAINER' THEN
    SELECT trainer_resource_id,total_minor,currency
    INTO v_employee,v_total,v_currency
    FROM trainer_payroll_statement
    WHERE tenant_id=NEW.tenant_id AND id=NEW.statement_id;
  ELSE
    SELECT employee_resource_id,total_minor,currency
    INTO v_employee,v_total,v_currency
    FROM service_employee_payroll_statement
    WHERE tenant_id=NEW.tenant_id AND id=NEW.statement_id;
  END IF;

  IF v_employee IS NULL THEN
    RAISE EXCEPTION 'PAYROLL_REVIEW_STATEMENT_NOT_FOUND'
      USING ERRCODE='23514';
  END IF;
  IF v_employee IS DISTINCT FROM NEW.employee_resource_id THEN
    RAISE EXCEPTION 'PAYROLL_REVIEW_EMPLOYEE_MISMATCH'
      USING ERRCODE='23514';
  END IF;
  IF v_total IS DISTINCT FROM NEW.statement_total_minor_snapshot THEN
    RAISE EXCEPTION 'PAYROLL_REVIEW_TOTAL_SNAPSHOT_MISMATCH'
      USING ERRCODE='23514';
  END IF;
  IF v_currency IS DISTINCT FROM NEW.currency THEN
    RAISE EXCEPTION 'PAYROLL_REVIEW_CURRENCY_MISMATCH'
      USING ERRCODE='23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER payroll_statement_review_guard_v1
BEFORE INSERT OR UPDATE OF
  statement_kind,statement_id,employee_resource_id,
  statement_total_minor_snapshot,currency
ON payroll_statement_review
FOR EACH ROW EXECUTE FUNCTION corebiz_payroll_statement_review_guard();

CREATE OR REPLACE FUNCTION corebiz_payroll_review_invalidate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
DECLARE
  v_kind text;
  v_review payroll_statement_review%ROWTYPE;
BEGIN
  IF NEW.total_minor IS NOT DISTINCT FROM OLD.total_minor THEN
    RETURN NEW;
  END IF;

  v_kind := CASE TG_TABLE_NAME
    WHEN 'trainer_payroll_statement' THEN 'DANCE_TRAINER'
    ELSE 'SERVICE_EMPLOYEE'
  END;

  SELECT *
  INTO v_review
  FROM payroll_statement_review
  WHERE tenant_id=NEW.tenant_id
    AND statement_kind=v_kind
    AND statement_id=NEW.id
  FOR UPDATE;

  IF v_review.id IS NULL THEN
    RETURN NEW;
  END IF;

  UPDATE payroll_statement_review
  SET review_status='PENDING',
      statement_total_minor_snapshot=NEW.total_minor,
      reviewer_membership_id=NULL,
      employee_comment=NULL,
      manager_comment=NULL,
      acknowledged_at=NULL,
      disputed_at=NULL,
      resolved_at=NULL,
      resolved_by_membership_id=NULL,
      updated_at=now()
  WHERE id=v_review.id;

  INSERT INTO payroll_statement_review_event(
    tenant_id,review_id,event_type,previous_status,new_status,
    comment,statement_total_minor_snapshot,metadata
  ) VALUES(
    NEW.tenant_id,v_review.id,'INVALIDATED',
    v_review.review_status,'PENDING',
    'Сумма ведомости изменилась после предыдущего согласования',
    NEW.total_minor,
    jsonb_build_object(
      'oldTotalMinor',OLD.total_minor,
      'newTotalMinor',NEW.total_minor,
      'statementKind',v_kind
    )
  );

  RETURN NEW;
END;
$$;

CREATE TRIGGER trainer_payroll_review_invalidate_v1
AFTER UPDATE OF total_minor
ON trainer_payroll_statement
FOR EACH ROW EXECUTE FUNCTION corebiz_payroll_review_invalidate();

CREATE TRIGGER service_payroll_review_invalidate_v1
AFTER UPDATE OF total_minor
ON service_employee_payroll_statement
FOR EACH ROW EXECUTE FUNCTION corebiz_payroll_review_invalidate();

ALTER TABLE payroll_statement_review ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_statement_review_event ENABLE ROW LEVEL SECURITY;

CREATE POLICY payroll_statement_review_isolation
  ON payroll_statement_review
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  );

CREATE POLICY payroll_statement_review_event_isolation
  ON payroll_statement_review_event
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  );

CREATE TRIGGER payroll_statement_review_tenant_refs_v1
BEFORE INSERT OR UPDATE ON payroll_statement_review
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'employee_resource_id','service_resource',
  'reviewer_membership_id','tenant_membership',
  'resolved_by_membership_id','tenant_membership'
);

CREATE TRIGGER payroll_statement_review_event_tenant_refs_v1
BEFORE INSERT OR UPDATE ON payroll_statement_review_event
FOR EACH ROW EXECUTE FUNCTION corebiz_guard_tenant_references(
  'review_id','payroll_statement_review',
  'actor_membership_id','tenant_membership'
);

COMMIT;
