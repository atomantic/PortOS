#!/usr/bin/env node
// Migrate a PortOS data directory from "World" naming to "Universe" naming.
// Run this on a machine whose data files still use the old keys (worldId,
// worldRun, top-level `worlds: []`, `data/world-builder.json` filename).
//
// Usage:
//   node server/scripts/migrateWorldToUniverse.js [--dry-run] [--data-dir <path>]
//
// Default data-dir is `./data` relative to the repo root. Idempotent — safe
// to re-run, no-op once everything is on the new names.

import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const dataDirArg = args.indexOf('--data-dir');
const DATA_DIR = resolve(dataDirArg >= 0 ? args[dataDirArg + 1] : 'data');

const log = (msg) => console.log(`${DRY_RUN ? '[dry-run] ' : ''}${msg}`);
const warn = (msg) => console.warn(`⚠️  ${msg}`);

function rewriteJson(path, transform, description) {
  if (!existsSync(path)) {
    log(`skip ${description}: ${path} not present`);
    return { touched: false };
  }
  const raw = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(raw);
  const next = transform(parsed);
  if (next === null) {
    log(`skip ${description}: already migrated`);
    return { touched: false };
  }
  if (DRY_RUN) {
    log(`would rewrite ${description} (${path})`);
    return { touched: true };
  }
  writeFileSync(path, JSON.stringify(next, null, 2));
  log(`✅ rewrote ${description}`);
  return { touched: true };
}

function rewriteTextKey(path, fromKey, toKey, description) {
  // For files where we want a key rename WITHOUT re-stringifying the entire
  // JSON (preserves the user's formatting + keeps the diff minimal). Only
  // matches the `"<fromKey>":` token so substrings inside string values can't
  // collide.
  if (!existsSync(path)) {
    log(`skip ${description}: ${path} not present`);
    return { touched: false, count: 0 };
  }
  const raw = readFileSync(path, 'utf-8');
  const pattern = new RegExp(`"${fromKey}"\\s*:`, 'g');
  const count = (raw.match(pattern) || []).length;
  if (count === 0) {
    log(`skip ${description}: no "${fromKey}" keys found`);
    return { touched: false, count: 0 };
  }
  const next = raw.replace(pattern, `"${toKey}":`);
  if (DRY_RUN) {
    log(`would rename ${count} "${fromKey}" → "${toKey}" key(s) in ${description}`);
    return { touched: true, count };
  }
  writeFileSync(path, next);
  log(`✅ renamed ${count} "${fromKey}" → "${toKey}" key(s) in ${description}`);
  return { touched: true, count };
}

function renameFileSafe(from, to, description) {
  if (!existsSync(from)) {
    log(`skip ${description}: ${from} not present`);
    return { touched: false };
  }
  if (existsSync(to)) {
    warn(`${description}: both ${from} and ${to} exist — leaving alone (rename manually if old file is stale)`);
    return { touched: false };
  }
  if (DRY_RUN) {
    log(`would rename ${from} → ${to}`);
    return { touched: true };
  }
  renameSync(from, to);
  log(`✅ renamed ${from} → ${to}`);
  return { touched: true };
}

async function main() {
  console.log(`Migrating world → universe under ${DATA_DIR}${DRY_RUN ? ' (DRY-RUN — no writes)' : ''}\n`);

  // 1. Rename data/world-builder.json → data/universe-builder.json.
  renameFileSafe(
    join(DATA_DIR, 'world-builder.json'),
    join(DATA_DIR, 'universe-builder.json'),
    'universe data file',
  );

  // 2. Inside the (now-renamed) universe file, top-level `worlds` → `universes`.
  rewriteJson(
    join(DATA_DIR, 'universe-builder.json'),
    (data) => {
      if (data.universes) return null;
      if (!Array.isArray(data.worlds)) return null;
      const { worlds, ...rest } = data;
      return { universes: worlds, ...rest };
    },
    'universe-builder.json top-level key',
  );

  // 3. In pipeline-series.json, rename every `series.worldId` → `series.universeId`.
  rewriteTextKey(
    join(DATA_DIR, 'pipeline-series.json'),
    'worldId',
    'universeId',
    'pipeline-series.json',
  );

  // 4. In media-jobs.json, rename every `params.worldRun` → `params.universeRun`.
  rewriteTextKey(
    join(DATA_DIR, 'media-jobs.json'),
    'worldRun',
    'universeRun',
    'media-jobs.json',
  );

  console.log(`\n✨ Migration complete${DRY_RUN ? ' (dry-run)' : ''}. ${DRY_RUN ? 'Re-run without --dry-run to apply.' : 'Restart the PortOS server to pick up the new schema.'}`);
}

main().catch((err) => { console.error('❌ Migration failed:', err); process.exit(1); });
