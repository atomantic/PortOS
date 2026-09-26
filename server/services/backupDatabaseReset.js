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
  const functions = names(/CREATE OR REPLACE FUNCTION ([a-z_][a-z_0-9]*)\(\)/g);
  const sequences = names(/CREATE SEQUENCE IF NOT EXISTS ([a-z_][a-z_0-9]*)/g);
  const literals = values => values.map(value => `'${value}'`).join(', ');
  const preflight = `DO $portos_restore$
  BEGIN
    IF EXISTS (
      SELECT 1 FROM pg_namespace n WHERE n.nspname = 'public'
      AND NOT (n.nspowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
        OR (pg_get_userbyid(n.nspowner) = 'pg_database_owner' AND
          (SELECT datdba FROM pg_database WHERE datname = current_database()) =
          (SELECT oid FROM pg_roles WHERE rolname = current_user)))
    ) THEN RAISE EXCEPTION 'Restore preflight: application schema is not owned by the database user'; END IF;

    IF EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind NOT IN ('i', 'I', 't')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass
        AND d.objid = c.oid AND d.deptype = 'e')
      AND (c.relowner <> (SELECT oid FROM pg_roles WHERE rolname = current_user)
        OR NOT ((c.relkind = 'r' AND c.relname IN (${literals(tables)}))
          OR (c.relkind = 'S' AND (c.relname IN (${literals(sequences)}) OR EXISTS (
            SELECT 1 FROM pg_depend d JOIN pg_class t ON t.oid = d.refobjid
            WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid
            AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
            AND t.relnamespace = n.oid AND t.relname IN (${literals(tables)})
          )))))
    ) THEN RAISE EXCEPTION 'Restore preflight: unexpected application-schema relation or owner'; END IF;

    IF EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass
        AND d.objid = p.oid AND d.deptype = 'e')
      AND (p.proname NOT IN (${literals(functions)}) OR p.pronargs <> 0
        OR p.proowner <> (SELECT oid FROM pg_roles WHERE rolname = current_user))
    ) THEN RAISE EXCEPTION 'Restore preflight: unexpected application-schema function or owner'; END IF;

    IF EXISTS (
      SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public' AND t.typrelid = 0 AND t.typelem = 0
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_type'::regclass
        AND d.objid = t.oid AND d.deptype = 'e')
    ) OR EXISTS (
      SELECT 1 FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
      WHERE n.nspname = 'public' AND e.extname NOT IN ('vector', 'pgcrypto')
    ) OR EXISTS (
      SELECT 1 FROM pg_depend d JOIN pg_namespace n ON n.oid = d.refobjid
      WHERE d.refclassid = 'pg_namespace'::regclass AND n.nspname = 'public'
      AND d.classid NOT IN ('pg_class'::regclass, 'pg_proc'::regclass, 'pg_type'::regclass, 'pg_extension'::regclass)
      AND NOT EXISTS (SELECT 1 FROM pg_depend e WHERE e.classid = d.classid
        AND e.objid = d.objid AND e.deptype = 'e')
    ) THEN RAISE EXCEPTION 'Restore preflight: unexpected application-schema object'; END IF;

    IF EXISTS (
      SELECT 1 FROM pg_constraint c JOIN pg_class parent ON parent.oid = c.confrelid
      JOIN pg_namespace pn ON pn.oid = parent.relnamespace
      JOIN pg_class child ON child.oid = c.conrelid
      JOIN pg_namespace cn ON cn.oid = child.relnamespace
      WHERE c.contype = 'f' AND pn.nspname = 'public' AND cn.nspname <> 'public'
    ) OR EXISTS (
      SELECT 1 FROM pg_depend d JOIN pg_rewrite r ON r.oid = d.objid
      JOIN pg_class v ON v.oid = r.ev_class JOIN pg_namespace vn ON vn.oid = v.relnamespace
      JOIN pg_class t ON t.oid = d.refobjid JOIN pg_namespace tn ON tn.oid = t.relnamespace
      WHERE d.classid = 'pg_rewrite'::regclass AND d.refclassid = 'pg_class'::regclass
      AND tn.nspname = 'public' AND vn.nspname <> 'public'
    ) THEN RAISE EXCEPTION 'Restore preflight: non-PortOS dependency on application schema'; END IF;
  END $portos_restore$;`;

  // A single DROP list permits dependencies BETWEEN approved tables. RESTRICT
  // remains the database-enforced backstop for every unanticipated dependency,
  // including changes between preflight and replay. Never use CASCADE here.
  const reset = `${preflight}
    DROP TABLE IF EXISTS ${tables.map(name => `public.${name}`).join(', ')} RESTRICT;
    DROP FUNCTION IF EXISTS ${functions.map(name => `public.${name}()`).join(', ')} RESTRICT;
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
