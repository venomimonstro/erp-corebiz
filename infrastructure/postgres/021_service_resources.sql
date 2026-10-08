BEGIN;

CREATE TABLE service_resource (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES branch(id) ON DELETE SET NULL,
  membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  type text NOT NULL
    CHECK (type IN (
      'EMPLOYEE','ROOM','EQUIPMENT','VEHICLE','WORKPLACE','HALL','MACHINE','OTHER'
    )),
  name text NOT NULL,
  code text,
  capacity integer NOT NULL DEFAULT 1 CHECK (capacity > 0),
  cost_per_hour_minor bigint NOT NULL DEFAULT 0 CHECK (cost_per_hour_minor >= 0),
  currency char(3) NOT NULL DEFAULT 'RUB',
  timezone text NOT NULL DEFAULT 'Europe/Moscow',
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','ARCHIVED')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE INDEX service_resource_branch_idx
  ON service_resource(tenant_id, branch_id, type, status);

CREATE TABLE service_skill (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','ARCHIVED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE service_resource_skill (
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  resource_id uuid NOT NULL REFERENCES service_resource(id) ON DELETE CASCADE,
  skill_id uuid NOT NULL REFERENCES service_skill(id) ON DELETE CASCADE,
  level integer NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 5),
  PRIMARY KEY (resource_id, skill_id)
);

CREATE TABLE service_resource_schedule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  resource_id uuid NOT NULL REFERENCES service_resource(id) ON DELETE CASCADE,
  weekday smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_minute smallint NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute smallint NOT NULL CHECK (end_minute BETWEEN 1 AND 1440),
  valid_from date,
  valid_to date,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_minute > start_minute)
);

CREATE INDEX service_resource_schedule_idx
  ON service_resource_schedule(tenant_id, resource_id, weekday);

CREATE TABLE service_resource_block (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  resource_id uuid NOT NULL REFERENCES service_resource(id) ON DELETE CASCADE,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  reason text,
  type text NOT NULL DEFAULT 'UNAVAILABLE'
    CHECK (type IN ('UNAVAILABLE','VACATION','SICK','MAINTENANCE','OTHER')),
  created_by_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);

CREATE INDEX service_resource_block_window_idx
  ON service_resource_block(tenant_id, resource_id, starts_at, ends_at);

ALTER TABLE service_resource ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_skill ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_resource_skill ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_resource_schedule ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_resource_block ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'service_resource','service_skill','service_resource_skill',
    'service_resource_schedule','service_resource_block'
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
SELECT r.tenant_id, r.id, 'service.read', 'all'
FROM tenant_role r
WHERE r.code IN ('ADMIN','SALES_HEAD','SALES_MANAGER','VIEWER')
ON CONFLICT DO NOTHING;

INSERT INTO role_permission(tenant_id, role_id, permission_code, scope)
SELECT r.tenant_id, r.id, 'service.write', 'all'
FROM tenant_role r
WHERE r.code IN ('ADMIN','SALES_HEAD','SALES_MANAGER')
ON CONFLICT DO NOTHING;

COMMIT;
