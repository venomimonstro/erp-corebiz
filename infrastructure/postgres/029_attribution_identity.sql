BEGIN;

CREATE TABLE marketing_identity_link (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  visitor_id uuid NOT NULL REFERENCES marketing_visitor(id) ON DELETE CASCADE,
  party_id uuid NOT NULL REFERENCES party(id) ON DELETE CASCADE,
  source text NOT NULL DEFAULT 'MANUAL'
    CHECK (source IN ('MANUAL','FORM','CHECKOUT','BOOKING','CALL','IMPORT','API')),
  confidence numeric(5,4) NOT NULL DEFAULT 1
    CHECK (confidence >= 0 AND confidence <= 1),
  linked_at timestamptz NOT NULL DEFAULT now(),
  linked_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  UNIQUE (tenant_id, visitor_id, party_id)
);

CREATE INDEX marketing_identity_party_idx
  ON marketing_identity_link(tenant_id, party_id, linked_at DESC);

CREATE TABLE marketing_touchpoint (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  touchpoint_key text NOT NULL,
  visitor_id uuid REFERENCES marketing_visitor(id) ON DELETE SET NULL,
  session_id uuid REFERENCES marketing_session(id) ON DELETE SET NULL,
  party_id uuid REFERENCES party(id) ON DELETE SET NULL,
  channel text NOT NULL DEFAULT 'WEB'
    CHECK (channel IN ('WEB','CALL','EMAIL','MESSENGER','OFFLINE','IMPORT','OTHER')),
  event_name text,
  source text,
  medium text,
  campaign text,
  content text,
  term text,
  yclid text,
  gclid text,
  vk_click_id text,
  is_direct boolean NOT NULL DEFAULT false,
  occurred_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, touchpoint_key)
);

CREATE INDEX marketing_touchpoint_party_idx
  ON marketing_touchpoint(tenant_id, party_id, occurred_at);

CREATE INDEX marketing_touchpoint_visitor_idx
  ON marketing_touchpoint(tenant_id, visitor_id, occurred_at);

CREATE INDEX marketing_touchpoint_campaign_idx
  ON marketing_touchpoint(tenant_id, source, medium, campaign, occurred_at);

CREATE TABLE marketing_conversion (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  party_id uuid REFERENCES party(id) ON DELETE SET NULL,
  visitor_id uuid REFERENCES marketing_visitor(id) ON DELETE SET NULL,
  source_type text NOT NULL
    CHECK (source_type IN ('LEAD','SALES_ORDER','PAYMENT','SERVICE_BOOKING','CALL','OTHER')),
  source_id uuid NOT NULL,
  conversion_type text NOT NULL
    CHECK (conversion_type IN ('LEAD','ORDER','PAYMENT','REFUND','BOOKING','COMPLETED_SERVICE')),
  occurred_at timestamptz NOT NULL,
  revenue_minor bigint NOT NULL DEFAULT 0,
  currency char(3) NOT NULL DEFAULT 'RUB',
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','REVERSED')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source_type, source_id, conversion_type)
);

CREATE INDEX marketing_conversion_party_idx
  ON marketing_conversion(tenant_id, party_id, occurred_at);

CREATE INDEX marketing_conversion_date_idx
  ON marketing_conversion(tenant_id, occurred_at, conversion_type);

CREATE TABLE marketing_attribution_result (
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  conversion_id uuid NOT NULL REFERENCES marketing_conversion(id) ON DELETE CASCADE,
  touchpoint_id uuid NOT NULL REFERENCES marketing_touchpoint(id) ON DELETE CASCADE,
  model text NOT NULL
    CHECK (model IN ('FIRST_TOUCH','LAST_TOUCH','LAST_NON_DIRECT','LINEAR')),
  weight numeric(12,8) NOT NULL CHECK (weight > 0 AND weight <= 1),
  attributed_revenue_minor bigint NOT NULL,
  calculated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversion_id, touchpoint_id, model)
);

CREATE INDEX marketing_attribution_campaign_idx
  ON marketing_attribution_result(tenant_id, model, calculated_at);

ALTER TABLE marketing_identity_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_touchpoint ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_conversion ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_attribution_result ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'marketing_identity_link',
    'marketing_touchpoint',
    'marketing_conversion',
    'marketing_attribution_result'
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

INSERT INTO marketing_touchpoint(
  tenant_id,
  touchpoint_key,
  visitor_id,
  session_id,
  party_id,
  channel,
  event_name,
  source,
  medium,
  campaign,
  content,
  term,
  yclid,
  gclid,
  vk_click_id,
  is_direct,
  occurred_at
)
SELECT
  s.tenant_id,
  'session:' || s.id::text,
  s.visitor_id,
  s.id,
  v.party_id,
  'WEB',
  'session_start',
  s.source,
  s.medium,
  s.campaign,
  s.content,
  s.term,
  s.yclid,
  s.gclid,
  s.vk_click_id,
  COALESCE(NULLIF(lower(s.source), ''), 'direct') IN ('direct','(direct)')
    OR (s.source IS NULL AND s.referrer_url IS NULL),
  s.started_at
FROM marketing_session s
JOIN marketing_visitor v
  ON v.tenant_id = s.tenant_id AND v.id = s.visitor_id
ON CONFLICT DO NOTHING;

COMMIT;
