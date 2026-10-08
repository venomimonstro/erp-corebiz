BEGIN;

ALTER TABLE warehouse_location_owner_movement
  DROP CONSTRAINT IF EXISTS warehouse_location_owner_movement_movement_type_check;

ALTER TABLE warehouse_location_owner_movement
  ADD CONSTRAINT warehouse_location_owner_movement_movement_type_check
  CHECK (movement_type IN (
    'BOOTSTRAP','RECEIPT','PUTAWAY','MOVE','PICK','SHIP',
    'RETURN','ADJUSTMENT','TRANSFER_IN','TRANSFER_OUT'
  ));

COMMIT;
