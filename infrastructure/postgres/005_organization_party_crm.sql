BEGIN;

CREATE TABLE legal_entity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  name text NOT NULL,
  inn text,
  kpp text,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX legal_entity_tenant_idx ON legal_entity(tenant_id);

CREATE TABLE branch (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  legal_entity_id uuid REFERENCES legal_entity(id) ON DELETE SET NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX branch_tenant_idx ON branch(tenant_id);

CREATE TABLE team (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES branch(id) ON DELETE SET NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX team_tenant_idx ON team(tenant_id);

CREATE TABLE team_membership (
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES team(id) ON DELETE CASCADE,
  membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, membership_id)
);

CREATE TABLE party (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('PERSON', 'ORGANIZATION')),
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'ARCHIVED', 'MERGED')),
  responsible_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX party_tenant_name_idx ON party(tenant_id, display_name);
CREATE INDEX party_responsible_idx ON party(tenant_id, responsible_membership_id);

CREATE TABLE party_role (
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  party_id uuid NOT NULL REFERENCES party(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('CUSTOMER', 'SUPPLIER', 'PARTNER', 'CONTRACTOR')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (party_id, role)
);

CREATE TABLE party_contact (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  party_id uuid NOT NULL REFERENCES party(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('PHONE', 'EMAIL', 'OTHER')),
  value text NOT NULL,
  label text,
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX party_contact_party_idx ON party_contact(tenant_id, party_id);

CREATE TABLE crm_pipeline (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  name text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX crm_pipeline_tenant_idx ON crm_pipeline(tenant_id);

CREATE TABLE crm_stage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  pipeline_id uuid NOT NULL REFERENCES crm_pipeline(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'NORMAL'
    CHECK (kind IN ('NORMAL', 'WON', 'LOST')),
  position integer NOT NULL CHECK (position >= 0),
  probability smallint CHECK (probability BETWEEN 0 AND 100),
  color text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pipeline_id, position)
);

CREATE INDEX crm_stage_pipeline_idx ON crm_stage(tenant_id, pipeline_id);

CREATE TABLE crm_deal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  pipeline_id uuid NOT NULL REFERENCES crm_pipeline(id) ON DELETE RESTRICT,
  stage_id uuid NOT NULL REFERENCES crm_stage(id) ON DELETE RESTRICT,
  party_id uuid REFERENCES party(id) ON DELETE SET NULL,
  responsible_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  title text NOT NULL,
  amount_minor bigint NOT NULL DEFAULT 0 CHECK (amount_minor >= 0),
  currency char(3) NOT NULL DEFAULT 'RUB',
  source text,
  expected_close_date date,
  lost_reason text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX crm_deal_stage_idx ON crm_deal(tenant_id, pipeline_id, stage_id);
CREATE INDEX crm_deal_responsible_idx ON crm_deal(tenant_id, responsible_membership_id);

CREATE TABLE crm_deal_stage_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  deal_id uuid NOT NULL REFERENCES crm_deal(id) ON DELETE CASCADE,
  from_stage_id uuid REFERENCES crm_stage(id) ON DELETE SET NULL,
  to_stage_id uuid NOT NULL REFERENCES crm_stage(id) ON DELETE RESTRICT,
  actor_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX crm_deal_stage_history_idx
  ON crm_deal_stage_history(tenant_id, deal_id, created_at DESC);

CREATE TABLE task (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  title text NOT NULL,
  type text NOT NULL DEFAULT 'OTHER',
  state text NOT NULL DEFAULT 'OPEN'
    CHECK (state IN ('OPEN', 'IN_PROGRESS', 'WAITING', 'DONE', 'CANCELLED')),
  priority text NOT NULL DEFAULT 'NORMAL'
    CHECK (priority IN ('LOW', 'NORMAL', 'HIGH', 'URGENT')),
  responsible_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  due_at timestamptz,
  linked_type text,
  linked_id uuid,
  description text,
  completed_at timestamptz,
  created_by_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX task_responsible_idx
  ON task(tenant_id, responsible_membership_id, state, due_at);

CREATE INDEX task_link_idx
  ON task(tenant_id, linked_type, linked_id);

ALTER TABLE legal_entity ENABLE ROW LEVEL SECURITY;
ALTER TABLE branch ENABLE ROW LEVEL SECURITY;
ALTER TABLE team ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_membership ENABLE ROW LEVEL SECURITY;
ALTER TABLE party ENABLE ROW LEVEL SECURITY;
ALTER TABLE party_role ENABLE ROW LEVEL SECURITY;
ALTER TABLE party_contact ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_pipeline ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_stage ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_deal ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_deal_stage_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE task ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'legal_entity','branch','team','team_membership',
    'party','party_role','party_contact',
    'crm_pipeline','crm_stage','crm_deal','crm_deal_stage_history','task'
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

CREATE OR REPLACE FUNCTION corebiz_seed_tenant_crm(p_tenant_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_pipeline uuid;
BEGIN
  INSERT INTO crm_pipeline(tenant_id, name, is_default)
  VALUES (p_tenant_id, 'Основные продажи', true)
  ON CONFLICT DO NOTHING;

  SELECT id INTO v_pipeline
  FROM crm_pipeline
  WHERE tenant_id = p_tenant_id
    AND is_default = true
  ORDER BY created_at ASC
  LIMIT 1;

  IF NOT EXISTS (
    SELECT 1 FROM crm_stage WHERE pipeline_id = v_pipeline
  ) THEN
    INSERT INTO crm_stage(
      tenant_id, pipeline_id, name, kind, position, probability, color
    ) VALUES
      (p_tenant_id, v_pipeline, 'Новая', 'NORMAL', 10, 10, '#9CA3AF'),
      (p_tenant_id, v_pipeline, 'Квалификация', 'NORMAL', 20, 25, '#60A5FA'),
      (p_tenant_id, v_pipeline, 'КП', 'NORMAL', 30, 50, '#A78BFA'),
      (p_tenant_id, v_pipeline, 'Переговоры', 'NORMAL', 40, 75, '#F59E0B'),
      (p_tenant_id, v_pipeline, 'Успешно', 'WON', 90, 100, '#10B981'),
      (p_tenant_id, v_pipeline, 'Проиграно', 'LOST', 100, 0, '#EF4444');
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION corebiz_tenant_crm_bootstrap_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM corebiz_seed_tenant_crm(NEW.id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER tenant_seed_crm
AFTER INSERT ON tenant
FOR EACH ROW
EXECUTE FUNCTION corebiz_tenant_crm_bootstrap_trigger();

DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT id FROM tenant LOOP
    PERFORM corebiz_seed_tenant_crm(t.id);
  END LOOP;
END;
$$;

COMMIT;
