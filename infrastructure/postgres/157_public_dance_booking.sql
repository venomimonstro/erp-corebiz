BEGIN;

ALTER TABLE site_form_binding
  DROP CONSTRAINT IF EXISTS site_form_binding_action_check;

ALTER TABLE site_form_binding
  ADD CONSTRAINT site_form_binding_action_check
  CHECK (action IN ('CRM_LEAD','BOOKING','DANCE_BOOKING'));

COMMIT;
