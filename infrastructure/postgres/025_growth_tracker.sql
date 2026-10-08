BEGIN;

CREATE TABLE tracker_site (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  name text NOT NULL,
  tracker_key text NOT NULL UNIQUE,
  allowed_domains jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','DISABLED')),
  created_by_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE marketing_visitor (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  visitor_key_hash text NOT NULL,
  analytics_consent text NOT NULL DEFAULT 'UNKNOWN'
    CHECK (analytics_consent IN ('UNKNOWN','GRANTED')),
  ads_consent text NOT NULL DEFAULT 'UNKNOWN'
    CHECK (ads_consent IN ('UNKNOWN','GRANTED','DENIED')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  party_id uuid REFERENCES party(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, visitor_key_hash)
);

CREATE TABLE marketing_session (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  visitor_id uuid NOT NULL REFERENCES marketing_visitor(id) ON DELETE CASCADE,
  session_key_hash text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_event_at timestamptz NOT NULL DEFAULT now(),
  landing_url text,
  referrer_url text,
  source text,
  medium text,
  campaign text,
  content text,
  term text,
  yclid text,
  gclid text,
  vk_click_id text,
  ip_hash text,
  user_agent_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, session_key_hash)
);

CREATE INDEX marketing_session_visitor_idx
  ON marketing_session(tenant_id, visitor_id, started_at DESC);

CREATE INDEX marketing_session_campaign_idx
  ON marketing_session(tenant_id, source, medium, campaign, started_at DESC);

CREATE TABLE marketing_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  visitor_id uuid NOT NULL REFERENCES marketing_visitor(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES marketing_session(id) ON DELETE CASCADE,
  event_key text NOT NULL,
  event_name text NOT NULL,
  occurred_at timestamptz NOT NULL,
  page_url text,
  title text,
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  party_id uuid REFERENCES party(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, event_key)
);

CREATE INDEX marketing_event_session_idx
  ON marketing_event(tenant_id, session_id, occurred_at);

CREATE INDEX marketing_event_name_idx
  ON marketing_event(tenant_id, event_name, occurred_at DESC);

ALTER TABLE tracker_site ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_visitor ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_event ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'tracker_site','marketing_visitor','marketing_session','marketing_event'
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

INSERT INTO role_permission(tenant_id, role_id, permission_code, scope)
SELECT r.tenant_id, r.id, 'analytics.read', 'all'
FROM tenant_role r
WHERE r.code IN ('ADMIN','FINANCE','SALES_HEAD','VIEWER')
ON CONFLICT DO NOTHING;

INSERT INTO role_permission(tenant_id, role_id, permission_code, scope)
SELECT r.tenant_id, r.id, 'analytics.manage', 'all'
FROM tenant_role r
WHERE r.code = 'ADMIN'
ON CONFLICT DO NOTHING;

COMMIT;
