BEGIN;

CREATE TABLE marketing_identity_link (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  visitor_id uuid NOT NULL REFERENCES marketing_visitor(id) ON DELETE CASCADE,
  party_id uuid NOT NULL REFERENCES party(id) ON DELETE CASCADE,
  source text NOT NULL
    CHECK (source IN ('FORM','CRM','API','IMPORT','MANUAL')),
  confidence numeric(5,4) NOT NULL DEFAULT 1.0000
    CHECK (confidence >= 0 AND confidence <= 1),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  linked_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (tenant_id, visitor_id, party_id)
);

CREATE INDEX marketing_identity_party_idx
  ON marketing_identity_link(tenant_id, party_id, created_at DESC);

CREATE TABLE marketing_touchpoint (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  visitor_id uuid NOT NULL REFERENCES marketing_visitor(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES marketing_session(id) ON DELETE CASCADE,
  party_id uuid REFERENCES party(id) ON DELETE SET NULL,
  occurred_at timestamptz NOT NULL,
  source text,
  medium text,
  campaign text,
  content text,
  term text,
  yclid text,
  gclid text,
  vk_click_id text,
  landing_url text,
  referrer_url text,
  is_paid boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, session_id)
);

CREATE INDEX marketing_touchpoint_party_idx
  ON marketing_touchpoint(tenant_id, party_id, occurred_at);

CREATE INDEX marketing_touchpoint_campaign_idx
  ON marketing_touchpoint(tenant_id, source, campaign, occurred_at DESC);

CREATE TABLE attribution_result (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  party_id uuid NOT NULL REFERENCES party(id) ON DELETE CASCADE,
  conversion_type text NOT NULL
    CHECK (conversion_type IN ('SALES_ORDER','SERVICE_BOOKING')),
  conversion_id uuid NOT NULL,
  conversion_at timestamptz NOT NULL,
  model text NOT NULL
    CHECK (model IN ('FIRST_TOUCH','LAST_TOUCH','LAST_PAID_TOUCH')),
  touchpoint_id uuid REFERENCES marketing_touchpoint(id) ON DELETE SET NULL,
  source text,
  medium text,
  campaign text,
  credit numeric(8,6) NOT NULL DEFAULT 1.000000
    CHECK (credit >= 0 AND credit <= 1),
  lookback_days integer NOT NULL DEFAULT 90 CHECK (lookback_days BETWEEN 1 AND 365),
  computed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, conversion_type, conversion_id, model)
);

CREATE INDEX attribution_result_campaign_idx
  ON attribution_result(tenant_id, model, source, campaign, conversion_at DESC);

ALTER TABLE marketing_identity_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_touchpoint ENABLE ROW LEVEL SECURITY;
ALTER TABLE attribution_result ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'marketing_identity_link','marketing_touchpoint','attribution_result'
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
