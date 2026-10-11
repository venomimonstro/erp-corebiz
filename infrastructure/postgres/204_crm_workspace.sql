BEGIN;

ALTER TABLE crm_deal
  ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'NORMAL',
  ADD COLUMN IF NOT EXISTS lead_score integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_action_at timestamptz,
  ADD COLUMN IF NOT EXISTS next_action_title text,
  ADD COLUMN IF NOT EXISTS closed_at timestamptz,
  ADD COLUMN IF NOT EXISTS won_at timestamptz,
  ADD COLUMN IF NOT EXISTS lost_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_activity_at timestamptz,
  ADD COLUMN IF NOT EXISTS utm_source text,
  ADD COLUMN IF NOT EXISTS utm_medium text,
  ADD COLUMN IF NOT EXISTS utm_campaign text,
  ADD COLUMN IF NOT EXISTS external_id text;

ALTER TABLE crm_deal
  DROP CONSTRAINT IF EXISTS crm_deal_priority_ck,
  DROP CONSTRAINT IF EXISTS crm_deal_lead_score_ck;

ALTER TABLE crm_deal
  ADD CONSTRAINT crm_deal_priority_ck
    CHECK(priority IN ('LOW','NORMAL','HIGH','URGENT')),
  ADD CONSTRAINT crm_deal_lead_score_ck
    CHECK(lead_score BETWEEN 0 AND 100);

CREATE INDEX IF NOT EXISTS crm_deal_next_action_idx
  ON crm_deal(tenant_id,responsible_membership_id,next_action_at)
  WHERE next_action_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS crm_deal_last_activity_idx
  ON crm_deal(tenant_id,last_activity_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS crm_deal_external_id_uq
  ON crm_deal(tenant_id,external_id)
  WHERE external_id IS NOT NULL;

CREATE TABLE crm_tag (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  name text NOT NULL,
  color text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,name),
  UNIQUE(tenant_id,id)
);

CREATE TABLE crm_deal_tag (
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  deal_id uuid NOT NULL REFERENCES crm_deal(id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES crm_tag(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(deal_id,tag_id)
);

CREATE TABLE crm_note (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  deal_id uuid NOT NULL REFERENCES crm_deal(id) ON DELETE CASCADE,
  body text NOT NULL CHECK(length(btrim(body)) BETWEEN 1 AND 10000),
  pinned boolean NOT NULL DEFAULT false,
  created_by_membership_id uuid
    REFERENCES tenant_membership(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX crm_note_deal_idx
  ON crm_note(tenant_id,deal_id,pinned DESC,created_at DESC);

CREATE TABLE crm_activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  deal_id uuid NOT NULL REFERENCES crm_deal(id) ON DELETE CASCADE,
  party_id uuid REFERENCES party(id) ON DELETE SET NULL,
  activity_type text NOT NULL
    CHECK(activity_type IN (
      'CALL','EMAIL','MEETING','MESSAGE','TASK','NOTE',
      'STAGE_CHANGE','FORM_SUBMISSION','ORDER_CREATED',
      'PROJECT_CREATED','PAYMENT','SYSTEM'
    )),
  direction text
    CHECK(direction IS NULL OR direction IN ('INBOUND','OUTBOUND')),
  subject text,
  body text,
  happened_at timestamptz NOT NULL DEFAULT now(),
  due_at timestamptz,
  completed_at timestamptz,
  responsible_membership_id uuid
    REFERENCES tenant_membership(id) ON DELETE SET NULL,
  created_by_membership_id uuid
    REFERENCES tenant_membership(id) ON DELETE SET NULL,
  source_type text,
  source_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX crm_activity_deal_idx
  ON crm_activity(tenant_id,deal_id,happened_at DESC,id DESC);

CREATE INDEX crm_activity_due_idx
  ON crm_activity(
    tenant_id,responsible_membership_id,due_at
  )
  WHERE completed_at IS NULL AND due_at IS NOT NULL;

CREATE TABLE crm_automation_rule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  pipeline_id uuid REFERENCES crm_pipeline(id) ON DELETE CASCADE,
  stage_id uuid REFERENCES crm_stage(id) ON DELETE CASCADE,
  name text NOT NULL,
  trigger_type text NOT NULL
    CHECK(trigger_type IN (
      'DEAL_CREATED','STAGE_ENTERED','STAGE_STALE',
      'NO_NEXT_ACTION','DEAL_WON','DEAL_LOST'
    )),
  trigger_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  action_type text NOT NULL
    CHECK(action_type IN (
      'CREATE_TASK','SET_RESPONSIBLE','SET_PRIORITY',
      'ADD_TAG','CREATE_PROJECT','CREATE_ORDER'
    )),
  action_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK(status IN ('ACTIVE','PAUSED','ARCHIVED')),
  created_by_membership_id uuid
    REFERENCES tenant_membership(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX crm_automation_rule_trigger_idx
  ON crm_automation_rule(
    tenant_id,pipeline_id,stage_id,trigger_type,status
  );

CREATE OR REPLACE FUNCTION corebiz_crm_deal_close_dates()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
DECLARE
  stage_kind text;
BEGIN
  SELECT kind INTO stage_kind
  FROM crm_stage
  WHERE tenant_id=NEW.tenant_id AND id=NEW.stage_id;

  IF stage_kind='WON' AND (
    TG_OP='INSERT' OR NEW.stage_id IS DISTINCT FROM OLD.stage_id
  ) THEN
    NEW.won_at:=coalesce(NEW.won_at,now());
    NEW.closed_at:=coalesce(NEW.closed_at,now());
    NEW.lost_at:=NULL;
  ELSIF stage_kind='LOST' AND (
    TG_OP='INSERT' OR NEW.stage_id IS DISTINCT FROM OLD.stage_id
  ) THEN
    NEW.lost_at:=coalesce(NEW.lost_at,now());
    NEW.closed_at:=coalesce(NEW.closed_at,now());
    NEW.won_at:=NULL;
  ELSIF stage_kind='NORMAL' THEN
    NEW.closed_at:=NULL;
    NEW.won_at:=NULL;
    NEW.lost_at:=NULL;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER crm_deal_close_dates_v1
BEFORE INSERT OR UPDATE OF stage_id ON crm_deal
FOR EACH ROW EXECUTE FUNCTION corebiz_crm_deal_close_dates();

CREATE OR REPLACE FUNCTION corebiz_crm_activity_touch_deal()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=public,pg_temp
AS $$
BEGIN
  UPDATE crm_deal
  SET last_activity_at=GREATEST(
        coalesce(last_activity_at,'epoch'::timestamptz),
        NEW.happened_at
      ),
      updated_at=now()
  WHERE tenant_id=NEW.tenant_id AND id=NEW.deal_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER crm_activity_touch_deal_v1
AFTER INSERT ON crm_activity
FOR EACH ROW EXECUTE FUNCTION corebiz_crm_activity_touch_deal();

DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'crm_tag','crm_deal_tag','crm_note',
    'crm_activity','crm_automation_rule'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);
    EXECUTE format(
      'CREATE POLICY %I ON %I
       USING (
         tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid
       )
       WITH CHECK (
         tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid
       )',
      tbl||'_isolation',tbl
    );
  END LOOP;
END;
$$;

COMMIT;
