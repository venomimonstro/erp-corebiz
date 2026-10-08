BEGIN;

CREATE TABLE channel_connection (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  provider text NOT NULL
    CHECK (provider IN ('OWN_SITE','API','OZON','WILDBERRIES','YANDEX_MARKET')),
  name text NOT NULL,
  credentials_ciphertext text,
  webhook_secret_hash text,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','DEGRADED','DISABLED')),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  sync_cursor jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at timestamptz,
  last_received_at timestamptz,
  last_error text,
  created_by_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX channel_connection_provider_idx
  ON channel_connection(tenant_id, provider, status);

CREATE TABLE channel_product_mapping (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES channel_connection(id) ON DELETE CASCADE,
  external_offer_id text NOT NULL,
  external_barcode text,
  sku_id uuid NOT NULL REFERENCES sku(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','ARCHIVED')),
  created_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, external_offer_id)
);

CREATE INDEX channel_product_mapping_sku_idx
  ON channel_product_mapping(tenant_id, sku_id);

CREATE TABLE channel_order_inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES channel_connection(id) ON DELETE CASCADE,
  external_order_id text NOT NULL,
  external_status text,
  currency char(3) NOT NULL DEFAULT 'RUB',
  ordered_at timestamptz,
  status text NOT NULL DEFAULT 'RECEIVED'
    CHECK (status IN (
      'RECEIVED','NEEDS_MAPPING','READY','IMPORTING',
      'IMPORTED','IGNORED','FAILED'
    )),
  sales_order_id uuid REFERENCES sales_order(id) ON DELETE SET NULL,
  customer_hint jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload_hash text NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  received_at timestamptz NOT NULL DEFAULT now(),
  imported_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, external_order_id)
);

CREATE INDEX channel_order_inbox_queue_idx
  ON channel_order_inbox(tenant_id, status, received_at);

CREATE TABLE channel_order_line_inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  inbox_order_id uuid NOT NULL REFERENCES channel_order_inbox(id) ON DELETE CASCADE,
  external_line_id text,
  external_offer_id text NOT NULL,
  title text,
  quantity_milli bigint NOT NULL CHECK (quantity_milli > 0),
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
  discount_minor bigint NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  mapped_sku_id uuid REFERENCES sku(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX channel_order_line_inbox_order_idx
  ON channel_order_line_inbox(tenant_id, inbox_order_id);

CREATE TABLE channel_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES channel_connection(id) ON DELETE CASCADE,
  external_event_id text NOT NULL,
  event_type text NOT NULL,
  payload_hash text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, external_event_id)
);

ALTER TABLE channel_connection ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_product_mapping ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_order_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_order_line_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_event ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'channel_connection','channel_product_mapping','channel_order_inbox',
    'channel_order_line_inbox','channel_event'
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

CREATE OR REPLACE FUNCTION corebiz_resolve_channel_webhook(
  p_connection_id uuid
)
RETURNS TABLE(
  connection_id uuid,
  tenant_id uuid,
  provider text,
  webhook_secret_hash text,
  status text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT id, tenant_id, provider, webhook_secret_hash, status
  FROM channel_connection
  WHERE id = p_connection_id
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION corebiz_resolve_channel_webhook(uuid) FROM PUBLIC;

INSERT INTO role_permission(tenant_id, role_id, permission_code, scope)
SELECT r.tenant_id, r.id, 'channels.read', 'all'
FROM tenant_role r
WHERE r.code IN ('ADMIN','SALES_HEAD','VIEWER')
ON CONFLICT DO NOTHING;

INSERT INTO role_permission(tenant_id, role_id, permission_code, scope)
SELECT r.tenant_id, r.id, 'channels.manage', 'all'
FROM tenant_role r
WHERE r.code IN ('ADMIN','SALES_HEAD')
ON CONFLICT DO NOTHING;

COMMIT;
