-- Sprint 53a: Russian VAT document/register foundation.
-- This migration stores approved tax evidence; it does NOT calculate VAT.
BEGIN;
CREATE TABLE accounting_vat_document (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
 legal_entity_id uuid NOT NULL REFERENCES legal_entity(id) ON DELETE RESTRICT,
 document_kind text NOT NULL CHECK(document_kind IN ('ISSUED_INVOICE','RECEIVED_INVOICE','UPD','CORRECTION')),
 document_number text NOT NULL CHECK(length(btrim(document_number))>0),
 document_date date NOT NULL,
 counterparty_id uuid REFERENCES party(id) ON DELETE RESTRICT,
 source_type text NOT NULL CHECK(length(btrim(source_type))>0),
 source_id uuid NOT NULL,
 currency char(3) NOT NULL DEFAULT 'RUB',
 taxable_base_minor bigint NOT NULL CHECK(taxable_base_minor>=0),
 vat_amount_minor bigint NOT NULL CHECK(vat_amount_minor>=0),
 rate_code text NOT NULL CHECK(length(btrim(rate_code))>0),
 status text NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','APPROVED','CANCELLED')),
 approved_by_membership_id uuid REFERENCES tenant_membership(id) ON DELETE RESTRICT,
 approved_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(status<>'APPROVED' OR (approved_at IS NOT NULL AND approved_by_membership_id IS NOT NULL)),
 UNIQUE(tenant_id,legal_entity_id,document_kind,document_number,document_date),
 UNIQUE(tenant_id,id)
);
CREATE TABLE accounting_vat_register (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
 vat_document_id uuid NOT NULL,
 legal_entity_id uuid NOT NULL REFERENCES legal_entity(id) ON DELETE RESTRICT,
 event_date date NOT NULL,
 register_kind text NOT NULL CHECK(register_kind IN ('OUTPUT_VAT','INPUT_VAT','CORRECTION')),
 amount_minor bigint NOT NULL CHECK(amount_minor>=0),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (tenant_id,vat_document_id) REFERENCES accounting_vat_document(tenant_id,id),
 UNIQUE(tenant_id,vat_document_id,register_kind)
);
CREATE OR REPLACE FUNCTION corebiz_validate_vat_document()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM legal_entity e WHERE e.id=NEW.legal_entity_id AND e.tenant_id=NEW.tenant_id)
 THEN RAISE EXCEPTION 'VAT legal entity tenant mismatch' USING ERRCODE='23514'; END IF;
 IF NEW.counterparty_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM party p WHERE p.id=NEW.counterparty_id AND p.tenant_id=NEW.tenant_id
 ) THEN RAISE EXCEPTION 'VAT counterparty tenant mismatch' USING ERRCODE='23514'; END IF;
 IF NEW.approved_by_membership_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM tenant_membership m WHERE m.id=NEW.approved_by_membership_id AND m.tenant_id=NEW.tenant_id
 ) THEN RAISE EXCEPTION 'VAT approval actor tenant mismatch' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND OLD.status IN ('APPROVED','CANCELLED') AND
    (to_jsonb(OLD)-'status') IS DISTINCT FROM (to_jsonb(NEW)-'status')
 THEN RAISE EXCEPTION 'Approved VAT document financial snapshot is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;$$;
CREATE TRIGGER vat_document_validate_v1 BEFORE INSERT OR UPDATE ON accounting_vat_document
 FOR EACH ROW EXECUTE FUNCTION corebiz_validate_vat_document();

CREATE OR REPLACE FUNCTION corebiz_validate_vat_register()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(
  SELECT 1 FROM accounting_vat_document d
  WHERE d.id=NEW.vat_document_id AND d.tenant_id=NEW.tenant_id
    AND d.legal_entity_id=NEW.legal_entity_id AND d.status='APPROVED'
    AND d.vat_amount_minor=NEW.amount_minor
 ) THEN RAISE EXCEPTION 'VAT register/document mismatch or document not approved' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;$$;
CREATE TRIGGER vat_register_validate_v1 BEFORE INSERT ON accounting_vat_register
 FOR EACH ROW EXECUTE FUNCTION corebiz_validate_vat_register();

CREATE OR REPLACE FUNCTION corebiz_vat_register_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'VAT register is immutable; corrections need a new document' USING ERRCODE='23514'; END;$$;
CREATE TRIGGER vat_register_immutable_v1 BEFORE UPDATE OR DELETE ON accounting_vat_register
 FOR EACH ROW EXECUTE FUNCTION corebiz_vat_register_immutable();

DO $$
DECLARE tbl text;
BEGIN
 FOREACH tbl IN ARRAY ARRAY['accounting_vat_document','accounting_vat_register'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tbl);
  EXECUTE format(
   'CREATE POLICY %I ON %I USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',
   tbl||'_isolation',tbl);
 END LOOP;
END;$$;
COMMIT;
