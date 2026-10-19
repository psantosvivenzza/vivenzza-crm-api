-- Contencao limitada solicitada em 18/10/2026: somente ACL/RLS, sem DML.
-- Destino via conector explicito: Vivenzza vkncsyhugotyfwmxpzgq.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';
LOCK TABLE public.representante_vendedor_mapa IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='public.representante_vendedor_mapa'::regclass)
    OR EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='public.representante_vendedor_mapa'::regclass AND attnum>0 AND attacl IS NOT NULL)
    OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('anon','authenticated') AND (rolbypassrls OR rolsuper))
    OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role' AND rolbypassrls)
    OR NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      JOIN pg_roles r ON r.oid=p.proowner WHERE n.nspname='public'
      AND p.proname='fn_resolver_vendedor_por_representante' AND p.prosecdef
      AND r.rolname='postgres' AND r.rolbypassrls)
    OR NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner
      WHERE c.oid='public.representante_vendedor_mapa'::regclass AND NOT c.relforcerowsecurity
      AND r.rolname='postgres' AND r.rolbypassrls)
  THEN RAISE EXCEPTION 'Precondicoes de contencao divergentes'; END IF;
END $$;
ALTER TABLE public.representante_vendedor_mapa ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.representante_vendedor_mapa FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.representante_vendedor_mapa TO service_role;
DO $$
DECLARE r text; p text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
    FOREACH p IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] LOOP
      IF has_table_privilege(r,'public.representante_vendedor_mapa',p)
      THEN RAISE EXCEPTION 'Privilegio cliente ainda efetivo'; END IF;
    END LOOP;
  END LOOP;
  FOREACH p IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE'] LOOP
    IF NOT has_table_privilege('service_role','public.representante_vendedor_mapa',p)
    THEN RAISE EXCEPTION 'Backend sem privilegio necessario'; END IF;
  END LOOP;
  IF NOT (SELECT relrowsecurity AND NOT relforcerowsecurity FROM pg_class WHERE oid='public.representante_vendedor_mapa'::regclass)
  THEN RAISE EXCEPTION 'RLS nao habilitada'; END IF;
END $$;
COMMIT;
