/** Full restore resets known application objects, never arbitrary CASCADE targets. */
import { readFile } from 'node:fs/promises';

let resetPlan;

export async function getDatabaseResetPlan() {
  if (resetPlan) return resetPlan;
  const { buildUpgradeDdl, buildCatalogDdl } = await import('../lib/db/schema/index.js');
  const base = await readFile(new URL('../scripts/init-db.sql', import.meta.url), 'utf8');
  const ddl = [base, ...buildUpgradeDdl(), ...buildCatalogDdl()].join('\n');
  // These are trusted, shipped DDL declarations, never names from a backup or
  // the live database. Fail closed on objects not declared by this version.
  const names = (pattern) => [...new Set([...ddl.matchAll(pattern)].map(match => match[1]))];
  const tables = names(/CREATE TABLE IF NOT EXISTS ([a-z_][a-z_0-9]*)/g);
  // Recognize only the signatures currently shipped by the schema: trigger
  // functions without arguments, the catalog resolver's named TEXT input and
  // the catalog change clock's named TIMESTAMPTZ input (#12500).
  // Unsupported future declarations remain excluded and fail preflight closed.
  const functions = names(/CREATE OR REPLACE FUNCTION ([a-z_][a-z_0-9]*\((?:[a-z_][a-z_0-9]* (?:TEXT|TIMESTAMPTZ))?\))/g)
    .map(signature => `public.${signature.replace(/\([a-z_][a-z_0-9]* (TEXT|TIMESTAMPTZ)\)/, (_, type) => `(${type.toLowerCase()})`)}`);
  const views = names(/CREATE OR REPLACE VIEW ([a-z_][a-z_0-9]*)/g);
  const sequences = names(/CREATE SEQUENCE IF NOT EXISTS ([a-z_][a-z_0-9]*)/g);
  const literals = values => values.map(value => `'${value}'`).join(', ');
  const preflight = `DO $portos_restore$
  DECLARE obj text;
  BEGIN
    -- Each refusal names the first offending catalog object (identifiers only).
    obj := (
      SELECT format('%I', pg_get_userbyid(n.nspowner)) FROM pg_namespace n WHERE n.nspname = 'public'
      AND NOT (n.nspowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
        OR (pg_get_userbyid(n.nspowner) = 'pg_database_owner' AND
          (SELECT datdba FROM pg_database WHERE datname = current_database()) =
          (SELECT oid FROM pg_roles WHERE rolname = current_user)))
    );
    IF obj IS NOT NULL THEN RAISE EXCEPTION 'Restore preflight: application schema is not owned by the database user (owner %)', obj; END IF;

    obj := (
      SELECT format('%I (owner %I)', c.relname, pg_get_userbyid(c.relowner)) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind NOT IN ('i', 'I', 't')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass
        AND d.objid = c.oid AND d.deptype = 'e')
      AND (c.relowner <> (SELECT oid FROM pg_roles WHERE rolname = current_user)
        OR NOT ((c.relkind = 'r' AND c.relname IN (${literals(tables)}))
          OR (c.relkind = 'v' AND c.relname IN (${literals(views)}))
          OR (c.relkind = 'S' AND (c.relname IN (${literals(sequences)}) OR EXISTS (
            SELECT 1 FROM pg_depend d JOIN pg_class t ON t.oid = d.refobjid
            WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid
            AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
            AND t.relnamespace = n.oid AND t.relname IN (${literals(tables)})
          )))))
      LIMIT 1
    );
    IF obj IS NOT NULL THEN RAISE EXCEPTION 'Restore preflight: unexpected application-schema relation or owner: %', obj; END IF;

    obj := (
      SELECT format('%I (owner %I)', p.proname, pg_get_userbyid(p.proowner)) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass
        AND d.objid = p.oid AND d.deptype = 'e')
      AND (NOT EXISTS (SELECT 1 FROM unnest(ARRAY[${literals(functions)}]) AS allowed(signature)
          WHERE p.oid = to_regprocedure(allowed.signature))
        OR p.proowner <> (SELECT oid FROM pg_roles WHERE rolname = current_user))
      LIMIT 1
    );
    IF obj IS NOT NULL THEN RAISE EXCEPTION 'Restore preflight: unexpected application-schema function or owner: %', obj; END IF;

    obj := COALESCE((
      SELECT format('type %I', t.typname) FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public' AND t.typrelid = 0 AND t.typelem = 0
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_type'::regclass
        AND d.objid = t.oid AND d.deptype = 'e')
      LIMIT 1
    ), (
      SELECT format('extension %I', e.extname) FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
      WHERE n.nspname = 'public' AND e.extname NOT IN ('vector', 'pgcrypto')
      LIMIT 1
    ), (
      SELECT format('%s %s', d.classid::regclass::text, d.objid) FROM pg_depend d JOIN pg_namespace n ON n.oid = d.refobjid
      WHERE d.refclassid = 'pg_namespace'::regclass AND n.nspname = 'public'
      AND d.classid NOT IN ('pg_class'::regclass, 'pg_proc'::regclass, 'pg_type'::regclass, 'pg_extension'::regclass)
      AND NOT EXISTS (SELECT 1 FROM pg_depend e WHERE e.classid = d.classid
        AND e.objid = d.objid AND e.deptype = 'e')
      LIMIT 1
    ));
    IF obj IS NOT NULL THEN RAISE EXCEPTION 'Restore preflight: unexpected application-schema object: %', obj; END IF;

    obj := COALESCE((
      SELECT format('constraint %I', c.conname) FROM pg_constraint c JOIN pg_class parent ON parent.oid = c.confrelid
      JOIN pg_namespace pn ON pn.oid = parent.relnamespace
      JOIN pg_class child ON child.oid = c.conrelid
      JOIN pg_namespace cn ON cn.oid = child.relnamespace
      WHERE c.contype = 'f' AND pn.nspname = 'public' AND cn.nspname <> 'public'
      LIMIT 1
    ), (
      SELECT format('view %I', v.relname) FROM pg_depend d JOIN pg_rewrite r ON r.oid = d.objid
      JOIN pg_class v ON v.oid = r.ev_class JOIN pg_namespace vn ON vn.oid = v.relnamespace
      JOIN pg_class t ON t.oid = d.refobjid JOIN pg_namespace tn ON tn.oid = t.relnamespace
      WHERE d.classid = 'pg_rewrite'::regclass AND d.refclassid = 'pg_class'::regclass
      AND tn.nspname = 'public' AND vn.nspname <> 'public'
      LIMIT 1
    ));
    IF obj IS NOT NULL THEN RAISE EXCEPTION 'Restore preflight: non-PortOS dependency on application schema: %', obj; END IF;
  END $portos_restore$;`;

  // A single DROP list permits dependencies BETWEEN approved tables. RESTRICT
  // remains the database-enforced backstop for every unanticipated dependency,
  // including changes between preflight and replay. Never use CASCADE here.
  const reset = `${preflight}
    DROP VIEW IF EXISTS ${views.map(name => `public.${name}`).join(', ')} RESTRICT;
    DROP TABLE IF EXISTS ${tables.map(name => `public.${name}`).join(', ')} RESTRICT;
    DROP FUNCTION IF EXISTS ${functions.join(', ')} RESTRICT;
    DROP SEQUENCE IF EXISTS ${sequences.map(name => `public.${name}`).join(', ')} RESTRICT;
    CREATE SCHEMA IF NOT EXISTS public;
    CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;
    CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;`;
  // Keep the namespace (including its owner/ACLs) and installed extensions.
  // pg_dump's own clean statements can recreate extensions before their types
  // are consumed. All application tables, functions and sequence state reset.
  resetPlan = { preflight, reset };
  return resetPlan;
}
