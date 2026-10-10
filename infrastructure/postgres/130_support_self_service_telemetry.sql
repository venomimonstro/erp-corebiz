BEGIN;

CREATE TABLE support_knowledge_search (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  membership_id uuid NOT NULL REFERENCES tenant_membership(id) ON DELETE CASCADE,
  query_text text NOT NULL CHECK (length(query_text) <= 300),
  context_url text,
  result_count integer NOT NULL DEFAULT 0 CHECK (result_count >= 0),
  selected_article_id uuid REFERENCES knowledge_article(id) ON DELETE SET NULL,
  helpful boolean,
  ticket_id uuid REFERENCES support_ticket(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  selected_at timestamptz,
  feedback_at timestamptz,
  ticket_created_at timestamptz
);

CREATE INDEX support_knowledge_search_tenant_idx
  ON support_knowledge_search(tenant_id,created_at DESC);

CREATE INDEX support_knowledge_search_no_result_idx
  ON support_knowledge_search(tenant_id,result_count,created_at DESC)
  WHERE result_count=0;

ALTER TABLE support_knowledge_search ENABLE ROW LEVEL SECURITY;

CREATE POLICY support_knowledge_search_isolation
  ON support_knowledge_search
  USING (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
  );

INSERT INTO role_permission(tenant_id,role_id,permission_code,scope)
SELECT r.tenant_id,r.id,'support.telemetry.read','all'
FROM tenant_role r
WHERE r.code IN ('OWNER','ADMIN')
ON CONFLICT DO NOTHING;

COMMIT;
