BEGIN;

-- A single merchant-controlled HTTPS product image for first-party storefronts.
-- Keep product media tied to the existing tenant-scoped catalog and its RLS.
ALTER TABLE product ADD COLUMN IF NOT EXISTS image_url text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='product_image_https_check'
      AND conrelid='product'::regclass
  ) THEN
    ALTER TABLE product ADD CONSTRAINT product_image_https_check
      CHECK (
        image_url IS NULL
        OR (length(image_url) <= 2048 AND image_url LIKE 'https://%')
      ) NOT VALID;
  END IF;
END;
$$;

COMMIT;
