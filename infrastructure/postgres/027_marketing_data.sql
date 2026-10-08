BEGIN;

CREATE TABLE marketing_connection (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  provider text NOT NULL
    CHECK (provider IN ('YANDEX_DIRECT','VK_ADS','OTHER')),
  name text NOT NULL,
  external_account_id text,
  client_login text,
  credentials_ciphertext text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','DEGRADED','DISABLED')),
  last_synced_at timestamptz,
  last_error text,
  sync_cursor jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX marketing_connection_provider_idx
  ON marketing_connection(tenant_id, provider, status);

CREATE TABLE marketing_campaign (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES marketing_connection(id) ON DELETE CASCADE,
  external_campaign_id text NOT NULL,
  name text NOT NULL,
  status text,
  currency char(3) NOT NULL DEFAULT 'RUB',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, external_campaign_id)
);

CREATE INDEX marketing_campaign_lookup_idx
  ON marketing_campaign(tenant_id, external_campaign_id);

CREATE TABLE marketing_daily_stat (
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES marketing_connection(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL REFERENCES marketing_campaign(id) ON DELETE CASCADE,
  stat_date date NOT NULL,
  impressions bigint NOT NULL DEFAULT 0 CHECK (impressions >= 0),
  clicks bigint NOT NULL DEFAULT 0 CHECK (clicks >= 0),
  spend_minor bigint NOT NULL DEFAULT 0 CHECK (spend_minor >= 0),
  conversions numeric(18,4) NOT NULL DEFAULT 0 CHECK (conversions >= 0),
  external_revenue_minor bigint NOT NULL DEFAULT 0 CHECK (external_revenue_minor >= 0),
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, campaign_id, stat_date)
);

CREATE INDEX marketing_daily_stat_date_idx
  ON marketing_daily_stat(tenant_id, stat_date, campaign_id);

CREATE TABLE marketing_sync_job (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES marketing_connection(id) ON DELETE CASCADE,
  provider text NOT NULL,
  period_from date NOT NULL,
  period_to date NOT NULL,
  report_name text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','WAITING_PROVIDER','RUNNING','SUCCEEDED','FAILED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  retry_at timestamptz,
  provider_request_id text,
  last_error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_to >= period_from)
);

CREATE INDEX marketing_sync_job_queue_idx
  ON marketing_sync_job(status, retry_at, created_at)
  WHERE status IN ('PENDING','WAITING_PROVIDER','FAILED');

ALTER TABLE marketing_connection ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_campaign ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_daily_stat ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_sync_job ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'marketing_connection','marketing_campaign',
    'marketing_daily_stat','marketing_sync_job'
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
