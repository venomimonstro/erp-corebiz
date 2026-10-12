BEGIN;
-- A delivery refusal and carrier removal are terminal outcomes, not IN_TRANSIT.
-- Preserve original paid order, fiscal evidence, and inventory state separately.
ALTER TABLE commerce_shipment DROP CONSTRAINT IF EXISTS commerce_shipment_state_check;
ALTER TABLE commerce_shipment
  ADD CONSTRAINT commerce_shipment_state_check CHECK(
    state IN ('PREPARED','SENDING','UNKNOWN','SUBMITTED',
      'ACCEPTED','REJECTED','IN_TRANSIT','DELIVERED',
      'CANCELLED','NOT_DELIVERED','REMOVED'));
COMMIT;
