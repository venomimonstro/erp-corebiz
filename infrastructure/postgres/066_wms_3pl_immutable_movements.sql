-- Sprint 44d: financial-grade immutability for 3PL event ledgers.
-- Corrections must be compensating movements, never UPDATE/DELETE.
BEGIN;

CREATE OR REPLACE FUNCTION corebiz_3pl_movement_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION '3PL movement ledger is immutable; post a compensating movement'
    USING ERRCODE='23514';
END;
$$;

CREATE TRIGGER inventory_owner_movement_immutable_v1
BEFORE UPDATE OR DELETE ON inventory_owner_movement
FOR EACH ROW EXECUTE FUNCTION corebiz_3pl_movement_immutable();

CREATE TRIGGER warehouse_location_owner_movement_immutable_v1
BEFORE UPDATE OR DELETE ON warehouse_location_owner_movement
FOR EACH ROW EXECUTE FUNCTION corebiz_3pl_movement_immutable();

COMMIT;
