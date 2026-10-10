BEGIN;

CREATE TABLE finance_budget (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  name text NOT NULL,
  currency char(3) NOT NULL DEFAULT 'RUB',
  period_from date NOT NULL,
  period_to date NOT NULL,
  active_version_id uuid,
  created_by_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(period_from <= period_to),
  CHECK(period_to <= period_from + interval '24 months'),
  UNIQUE(tenant_id,name,period_from,period_to)
);

CREATE TABLE finance_budget_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  budget_id uuid NOT NULL REFERENCES finance_budget(id) ON DELETE CASCADE,
  version_no integer NOT NULL CHECK(version_no > 0),
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK(status IN ('DRAFT','PUBLISHED','SUPERSEDED')),
  created_by_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  published_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(budget_id,version_no)
);

ALTER TABLE finance_budget
  ADD CONSTRAINT finance_budget_active_version_fk
  FOREIGN KEY(tenant_id,active_version_id)
  REFERENCES finance_budget_version(tenant_id,id)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE finance_budget_version
  ADD CONSTRAINT finance_budget_version_tenant_unique
  UNIQUE(tenant_id,id);

CREATE UNIQUE INDEX finance_budget_one_draft_idx
  ON finance_budget_version(budget_id)
  WHERE status='DRAFT';

CREATE UNIQUE INDEX finance_budget_one_published_idx
  ON finance_budget_version(budget_id)
  WHERE status='PUBLISHED';

CREATE TABLE finance_budget_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  version_id uuid NOT NULL,
  month date NOT NULL,
  category_id uuid NOT NULL REFERENCES cash_flow_category(id) ON DELETE RESTRICT,
  planned_minor bigint NOT NULL CHECK(planned_minor >= 0),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,version_id)
    REFERENCES finance_budget_version(tenant_id,id) ON DELETE CASCADE,
  UNIQUE(version_id,month,category_id),
  CHECK(date_trunc('month',month)::date = month)
);

CREATE INDEX finance_budget_line_compare_idx
  ON finance_budget_line(tenant_id,version_id,month,category_id);

ALTER TABLE finance_budget ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_budget_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_budget_line ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'finance_budget','finance_budget_version','finance_budget_line'
  ]
  LOOP
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
      tbl || '_isolation',
      tbl
    );
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION corebiz_finance_budget_published_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF EXISTS(
      SELECT 1 FROM finance_budget_version v
      WHERE v.id=OLD.version_id AND v.status<>'DRAFT'
    ) THEN
      RAISE EXCEPTION 'Published budget lines are immutable';
    END IF;
    RETURN OLD;
  END IF;

  IF EXISTS(
    SELECT 1 FROM finance_budget_version v
    WHERE v.id=NEW.version_id AND v.status<>'DRAFT'
  ) THEN
    RAISE EXCEPTION 'Published budget lines are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER finance_budget_line_guard_v1
BEFORE INSERT OR UPDATE OR DELETE ON finance_budget_line
FOR EACH ROW EXECUTE FUNCTION corebiz_finance_budget_published_guard();

COMMIT;
