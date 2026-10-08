BEGIN;

CREATE TABLE migration_batch (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  entity_type text NOT NULL CHECK (entity_type IN ('PRODUCTS','CUSTOMERS')),
  source_type text NOT NULL CHECK (source_type IN ('CSV','XLSX','JSON')),
  filename text,
  checksum text NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'UPLOADED'
    CHECK (status IN (
      'UPLOADED','ANALYZED','VALIDATED','IMPORTED','RECONCILED','FAILED'
    )),
  mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
  validation_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  reconciliation_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  row_count integer NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  valid_count integer NOT NULL DEFAULT 0 CHECK (valid_count >= 0),
  error_count integer NOT NULL DEFAULT 0 CHECK (error_count >= 0),
  imported_count integer NOT NULL DEFAULT 0 CHECK (imported_count >= 0),
  created_by_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX migration_batch_status_idx
  ON migration_batch(tenant_id, status, created_at DESC);

CREATE TABLE migration_row (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  batch_id uuid NOT NULL REFERENCES migration_batch(id) ON DELETE CASCADE,
  row_number integer NOT NULL CHECK (row_number > 0),
  source_data jsonb NOT NULL,
  normalized_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','VALID','ERROR','IMPORTED','SKIPPED')),
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  target_type text,
  target_id uuid,
  fingerprint text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, row_number)
);

CREATE INDEX migration_row_batch_status_idx
  ON migration_row(tenant_id, batch_id, status, row_number);

CREATE INDEX migration_row_fingerprint_idx
  ON migration_row(tenant_id, fingerprint)
  WHERE fingerprint IS NOT NULL;

CREATE TABLE onboarding_state (
  tenant_id uuid PRIMARY KEY REFERENCES tenant(id) ON DELETE CASCADE,
  business_kind text,
  company_size text,
  sales_channels jsonb NOT NULL DEFAULT '[]'::jsonb,
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  migration_source text,
  first_value_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE migration_batch ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_row ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY migration_batch_isolation
  ON migration_batch
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY migration_row_isolation
  ON migration_row
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY onboarding_state_isolation
  ON onboarding_state
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

INSERT INTO role_permission(tenant_id, role_id, permission_code, scope)
SELECT r.tenant_id, r.id, 'migration.manage', 'all'
FROM tenant_role r
WHERE r.code = 'ADMIN'
ON CONFLICT DO NOTHING;

COMMIT;
