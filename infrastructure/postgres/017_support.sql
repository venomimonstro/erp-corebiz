BEGIN;

CREATE TABLE support_ticket (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  business_number text NOT NULL,
  subject text NOT NULL,
  status text NOT NULL DEFAULT 'NEW'
    CHECK (status IN (
      'NEW','OPEN','WAITING_CUSTOMER','WAITING_SUPPORT','RESOLVED','CLOSED'
    )),
  priority text NOT NULL DEFAULT 'NORMAL'
    CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT')),
  category text,
  context_url text,
  created_by_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  assigned_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, business_number)
);

CREATE INDEX support_ticket_queue_idx
  ON support_ticket(tenant_id, status, priority, updated_at DESC);

CREATE TABLE support_message (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  ticket_id uuid NOT NULL REFERENCES support_ticket(id) ON DELETE CASCADE,
  author_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  body text NOT NULL,
  visibility text NOT NULL DEFAULT 'PUBLIC'
    CHECK (visibility IN ('PUBLIC','INTERNAL')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX support_message_ticket_idx
  ON support_message(tenant_id, ticket_id, created_at);

CREATE TABLE support_attachment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  ticket_id uuid NOT NULL REFERENCES support_ticket(id) ON DELETE CASCADE,
  message_id uuid REFERENCES support_message(id) ON DELETE CASCADE,
  object_key text NOT NULL,
  filename text NOT NULL,
  mime_type text,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  uploaded_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE knowledge_article (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  title text NOT NULL,
  body_markdown text NOT NULL,
  category text,
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','PUBLISHED','ARCHIVED')),
  search_text text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);

CREATE INDEX knowledge_article_search_idx
  ON knowledge_article USING gin (to_tsvector('simple', search_text));

CREATE TABLE support_access_grant (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  scopes jsonb NOT NULL DEFAULT '["read"]'::jsonb,
  reason text,
  granted_by_membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE RESTRICT,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX support_access_grant_tenant_idx
  ON support_access_grant(tenant_id, expires_at);

ALTER TABLE support_ticket ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_message ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_attachment ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_access_grant ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'support_ticket','support_message','support_attachment','support_access_grant'
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

INSERT INTO knowledge_article(
  slug, title, body_markdown, category, status, search_text, published_at
)
VALUES
  (
    'first-company-setup',
    'Как начать работу с Business OS',
    '# Первый запуск

Создайте товары и клиентов вручную или через Migration Center. Затем создайте сделку, заказ и подтвердите его.',
    'Старт',
    'PUBLISHED',
    'первый запуск начало работа компания товары клиенты импорт migration',
    now()
  ),
  (
    'inventory-balance',
    'Почему физический, резерв и доступный остаток отличаются',
    '# Остатки

Физический остаток — то, что есть на складе. Резерв — количество под подтверждённые заказы. Доступно = физический минус резерв.',
    'Склад',
    'PUBLISHED',
    'склад остаток физический резерв доступно inventory',
    now()
  )
ON CONFLICT (slug) DO NOTHING;

INSERT INTO role_permission(tenant_id, role_id, permission_code, scope)
SELECT r.tenant_id, r.id, 'support.read', 'all'
FROM tenant_role r
WHERE r.code IN ('ADMIN','VIEWER','SALES_HEAD','SALES_MANAGER','PROCUREMENT','WAREHOUSE','FINANCE')
ON CONFLICT DO NOTHING;

INSERT INTO role_permission(tenant_id, role_id, permission_code, scope)
SELECT r.tenant_id, r.id, 'support.write', 'all'
FROM tenant_role r
WHERE r.code IN ('ADMIN','SALES_HEAD','SALES_MANAGER','PROCUREMENT','WAREHOUSE','FINANCE')
ON CONFLICT DO NOTHING;

COMMIT;
