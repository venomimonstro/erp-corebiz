-- Read-only SQL assertions on a disposable, fully migrated database.
-- A stale workflow event or exhausted workflow attempts must block pilot GO.
DO $$
DECLARE stale bigint; exhausted bigint; publicly_visible boolean;
BEGIN
  SELECT count(*) INTO stale FROM domain_event_outbox
  WHERE status='PROCESSING'
    AND (locked_at IS NULL OR locked_at<now()-interval '20 minutes');
  SELECT count(*) INTO exhausted FROM domain_event_outbox
  WHERE status IN ('FAILED','PROCESSING') AND attempts>=5
    AND created_at<now()-interval '20 minutes';

  SELECT EXISTS(
    SELECT 1 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='domain_event_outbox'
      AND c.relrowsecurity=true
  ) INTO publicly_visible;

  IF stale>0 OR exhausted>0 OR NOT publicly_visible THEN
    RAISE EXCEPTION
      'OUTBOX_RELEASE_BLOCKED: stale_processing %, exhausted %, rls_enabled %',
      stale,exhausted,publicly_visible;
  END IF;
  RAISE NOTICE 'PASS: outbox has RLS, no abandoned leases or exhausted actions';
END $$;
