BEGIN;

ALTER TABLE auth_mail_delivery
  ADD COLUMN IF NOT EXISTS delivered_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_provider_status text,
  ADD COLUMN IF NOT EXISTS last_provider_event_at timestamptz;

CREATE TABLE auth_mail_provider_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id uuid NOT NULL REFERENCES auth_mail_delivery(id) ON DELETE CASCADE,
  provider_job_id text NOT NULL,
  provider_status text NOT NULL,
  provider_event_at timestamptz NOT NULL,
  delivery_status text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider_job_id,provider_status,provider_event_at)
);

CREATE INDEX auth_mail_provider_event_delivery_idx
  ON auth_mail_provider_event(delivery_id,provider_event_at DESC);

REVOKE ALL ON auth_mail_provider_event FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.corebiz_record_auth_mail_provider_status(
  p_provider_job_id text,
  p_status text,
  p_event_at timestamptz,
  p_delivery_status text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
AS $$
DECLARE
  v_delivery_id uuid;
  v_event_at timestamptz;
BEGIN
  IF p_provider_job_id IS NULL
     OR length(btrim(p_provider_job_id)) NOT BETWEEN 1 AND 200
     OR p_status NOT IN (
       'accepted','sent','delivered','soft_bounced','hard_bounced',
       'spam','unsubscribed','subscribed'
     ) THEN
    RAISE EXCEPTION 'AUTH_MAIL_PROVIDER_EVENT_INVALID'
      USING ERRCODE='22023';
  END IF;

  v_event_at:=COALESCE(p_event_at,now());

  SELECT id INTO v_delivery_id
  FROM public.auth_mail_delivery
  WHERE provider_job_id=btrim(p_provider_job_id)
  FOR UPDATE;

  IF NOT FOUND THEN
    -- Unknown provider jobs are acknowledged without exposing whether a
    -- recipient/account exists. They may belong to other transactional mail.
    RETURN false;
  END IF;

  INSERT INTO public.auth_mail_provider_event(
    delivery_id,provider_job_id,provider_status,provider_event_at,
    delivery_status
  ) VALUES(
    v_delivery_id,btrim(p_provider_job_id),p_status,v_event_at,
    left(NULLIF(btrim(p_delivery_status),''),160)
  )
  ON CONFLICT(provider_job_id,provider_status,provider_event_at) DO NOTHING;

  UPDATE public.auth_mail_delivery
  SET last_provider_status=p_status,
      last_provider_event_at=GREATEST(
        COALESCE(last_provider_event_at,'epoch'::timestamptz),
        v_event_at
      ),
      delivered_at=CASE
        WHEN p_status='delivered'
          THEN COALESCE(delivered_at,v_event_at)
        ELSE delivered_at
      END,
      status=CASE
        WHEN p_status='hard_bounced' THEN 'BOUNCED'
        ELSE status
      END,
      last_error_code=CASE
        WHEN p_status='hard_bounced'
          THEN COALESCE(
            left(NULLIF(btrim(p_delivery_status),''),120),
            'HARD_BOUNCED'
          )
        ELSE last_error_code
      END,
      updated_at=now()
  WHERE id=v_delivery_id
    -- Ignore an older callback that arrived after a newer state.
    AND (
      last_provider_event_at IS NULL
      OR v_event_at>=last_provider_event_at
    );

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION
  public.corebiz_record_auth_mail_provider_status(text,text,timestamptz,text)
  FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='corebiz_app') THEN
    GRANT EXECUTE ON FUNCTION
      public.corebiz_record_auth_mail_provider_status(text,text,timestamptz,text)
      TO corebiz_app;
  END IF;
END;
$$;

COMMIT;
