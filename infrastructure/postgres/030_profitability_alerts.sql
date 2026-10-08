BEGIN;

CREATE TABLE marketing_campaign_alias (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL REFERENCES marketing_campaign(id) ON DELETE CASCADE,
  alias_type text NOT NULL
    CHECK (alias_type IN ('EXTERNAL_ID','UTM_CAMPAIGN','NAME','MANUAL')),
  alias_value text NOT NULL,
  created_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, alias_type, alias_value)
);

CREATE INDEX marketing_campaign_alias_campaign_idx
  ON marketing_campaign_alias(tenant_id, campaign_id);

INSERT INTO marketing_campaign_alias(
  tenant_id, campaign_id, alias_type, alias_value
)
SELECT tenant_id, id, 'EXTERNAL_ID', external_campaign_id
FROM marketing_campaign
ON CONFLICT DO NOTHING;

CREATE TABLE marketing_alert_rule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  name text NOT NULL,
  type text NOT NULL
    CHECK (type IN (
      'SPEND_WITHOUT_ORDERS',
      'CPO_ABOVE',
      'ROMI_BELOW',
      'CONTRIBUTION_PROFIT_BELOW'
    )),
  threshold_minor bigint,
  threshold_ratio numeric(18,6),
  lookback_days integer NOT NULL DEFAULT 7 CHECK (lookback_days BETWEEN 1 AND 90),
  attribution_model text NOT NULL DEFAULT 'LAST_PAID_TOUCH'
    CHECK (attribution_model IN ('FIRST_TOUCH','LAST_TOUCH','LAST_PAID_TOUCH')),
  enabled boolean NOT NULL DEFAULT true,
  created_by_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE marketing_alert_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  rule_id uuid NOT NULL REFERENCES marketing_alert_rule(id) ON DELETE CASCADE,
  campaign_id uuid REFERENCES marketing_campaign(id) ON DELETE CASCADE,
  window_from date NOT NULL,
  window_to date NOT NULL,
  severity text NOT NULL DEFAULT 'WARNING'
    CHECK (severity IN ('INFO','WARNING','CRITICAL')),
  status text NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','ACKNOWLEDGED','CLOSED')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  closed_at timestamptz,
  UNIQUE (rule_id, campaign_id, window_from, window_to)
);

CREATE INDEX marketing_alert_event_open_idx
  ON marketing_alert_event(tenant_id, status, created_at DESC);

ALTER TABLE marketing_campaign_alias ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_alert_rule ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_alert_event ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'marketing_campaign_alias','marketing_alert_rule','marketing_alert_event'
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

COMMIT;
