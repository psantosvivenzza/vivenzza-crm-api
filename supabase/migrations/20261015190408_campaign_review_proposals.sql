-- Local-only candidate; manual UTC filename authorized because CLI unavailable.
CREATE SCHEMA campaign_review;
REVOKE ALL ON SCHEMA campaign_review FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA campaign_review TO service_role;
CREATE TABLE campaign_review.proposals (
  id uuid PRIMARY KEY,
  revision integer NOT NULL CHECK (revision > 0),
  state text NOT NULL CHECK (state IN ('proposta','aprovada','rejeitada','em execução','confirmada','falhou','inconclusiva')),
  record jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(record) = 'object'),
  CHECK ((record->>'id') IS NOT NULL AND record->>'id' = id::text),
  CHECK ((record->>'revision') IS NOT NULL AND (record->>'revision')::integer = revision),
  CHECK ((record->>'state') IS NOT NULL AND record->>'state' = state),
  CHECK (record ? 'payload' AND jsonb_typeof(record->'payload') = 'object'),
  CHECK (COALESCE(jsonb_typeof(record->'payload'->'platform')='string' AND record->'payload'->>'platform' IN ('meta','google'),false)),
  CHECK (COALESCE(jsonb_typeof(record->'payload'->'accountId')='string' AND length(btrim(record->'payload'->>'accountId'))>0,false)),
  CHECK (COALESCE(jsonb_typeof(record->'payload'->'campaignId')='string' AND length(btrim(record->'payload'->>'campaignId'))>0,false)),
  CHECK (record ? 'hash' AND jsonb_typeof(record->'hash') = 'string' AND record->>'hash' ~ '^[a-f0-9]{64}$'),
  CHECK (record ? 'history' AND jsonb_typeof(record->'history') = 'array' AND jsonb_array_length(record->'history') = revision)
);
ALTER TABLE campaign_review.proposals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON campaign_review.proposals FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT,INSERT,UPDATE ON campaign_review.proposals TO service_role;
CREATE POLICY campaign_review_server ON campaign_review.proposals TO service_role USING (true) WITH CHECK (true);
CREATE FUNCTION campaign_review.guard_transition() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.revision <> 1 OR NEW.state <> 'proposta' OR NEW.record->'approval' IS DISTINCT FROM 'null'::jsonb THEN
      RAISE EXCEPTION 'INVALID_INITIAL_STATE' USING ERRCODE='23514';
    END IF;
  ELSE
    IF NEW.id <> OLD.id OR NEW.created_at <> OLD.created_at OR NEW.revision <> OLD.revision+1
       OR NEW.record->'payload' IS DISTINCT FROM OLD.record->'payload'
       OR NEW.record->'hash' IS DISTINCT FROM OLD.record->'hash'
       OR ((NEW.record->'history') - (NEW.revision-1)) IS DISTINCT FROM OLD.record->'history'
       OR NOT ((OLD.state='proposta' AND NEW.state IN ('aprovada','rejeitada'))
         OR (OLD.state='aprovada' AND NEW.state IN ('em execução','rejeitada'))
         OR (OLD.state='em execução' AND NEW.state IN ('confirmada','falhou','inconclusiva'))) THEN
      RAISE EXCEPTION 'INVALID_OR_MUTATED_TRANSITION' USING ERRCODE='23514';
    END IF;
    IF NEW.state='aprovada' THEN
      IF NEW.record->'approval'->>'hash' IS DISTINCT FROM NEW.record->>'hash'
         OR COALESCE(NEW.record->'approval'->>'actorId','') = '' THEN
        RAISE EXCEPTION 'INVALID_APPROVAL' USING ERRCODE='23514';
      END IF;
    ELSIF NEW.record->'approval' IS DISTINCT FROM OLD.record->'approval' THEN
      RAISE EXCEPTION 'APPROVAL_IMMUTABLE' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.record->'history'->(NEW.revision-1)->>'state' IS DISTINCT FROM NEW.state THEN
    RAISE EXCEPTION 'HISTORY_STATE_MISMATCH' USING ERRCODE='23514';
  END IF;
  IF COALESCE(NEW.record->'history'->(NEW.revision-1)->>'actorId','')='' THEN
    RAISE EXCEPTION 'HISTORY_ACTOR_REQUIRED' USING ERRCODE='23514';
  END IF;
  IF NEW.state='rejeitada' AND (COALESCE(NEW.record->'rejection'->>'actorId','')=''
     OR COALESCE(length(btrim(NEW.record->'rejection'->>'reason')),0) NOT BETWEEN 1 AND 1000) THEN
    RAISE EXCEPTION 'REJECTION_REASON_REQUIRED' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION campaign_review.guard_transition() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION campaign_review.guard_transition() TO service_role;
CREATE TRIGGER campaign_review_transition BEFORE INSERT OR UPDATE ON campaign_review.proposals
FOR EACH ROW EXECUTE FUNCTION campaign_review.guard_transition();
CREATE UNIQUE INDEX campaign_review_single_active_target ON campaign_review.proposals
((record->'payload'->>'platform'),(record->'payload'->>'accountId'),(record->'payload'->>'campaignId'))
WHERE state IN ('em execução','inconclusiva');
