BEGIN;

-- Exactly one live checkout attempt per public cart. Keep historical filenames intact.
ALTER TABLE storefront_cart
  ADD COLUMN IF NOT EXISTS checkout_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS checkout_attempt_token text,
  ADD COLUMN IF NOT EXISTS checkout_party_id uuid REFERENCES party(id) ON DELETE SET NULL;

ALTER TABLE storefront_cart
  DROP CONSTRAINT IF EXISTS storefront_cart_status_check;

ALTER TABLE storefront_cart
  ADD CONSTRAINT storefront_cart_status_check
    CHECK (status IN ('OPEN','PROCESSING','CHECKED_OUT','EXPIRED','ABANDONED'));

CREATE INDEX IF NOT EXISTS storefront_cart_stale_processing_idx
  ON storefront_cart(checkout_started_at)
  WHERE status='PROCESSING';

COMMIT;
