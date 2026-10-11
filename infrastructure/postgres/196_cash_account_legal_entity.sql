BEGIN;

ALTER TABLE cash_account
  ADD COLUMN IF NOT EXISTS legal_entity_id uuid
    REFERENCES legal_entity(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS cash_account_legal_entity_idx
  ON cash_account(tenant_id,legal_entity_id,status);

UPDATE cash_account a
SET legal_entity_id=(
  SELECT min(l.id::text)::uuid
  FROM legal_entity l
  WHERE l.tenant_id=a.tenant_id
    AND l.status='ACTIVE'
)
WHERE a.legal_entity_id IS NULL
  AND 1=(
    SELECT count(*)
    FROM legal_entity l
    WHERE l.tenant_id=a.tenant_id
      AND l.status='ACTIVE'
  );

COMMIT;
