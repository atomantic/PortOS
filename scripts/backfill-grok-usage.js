#!/usr/bin/env node
/**
 * Repair Grok usage that the DevTools Usage page undercounted.
 *
 * Cached-input prices and the removed cache-write surcharge do not need this
 * script. Those rates are applied when the page is built, so reloading Usage
 * after the upgrade re-prices every token already in data/usage.json.
 *
 * This script adds only charges the ledger can still prove:
 *
 *   - the extra 1× on a Grok CLI turn whose own prompt was at least 200,000
 *     tokens, when that turn is still on disk and its timestamp is at or
 *     before the interactive-scan watermark (the scan already billed the base
 *     tokens without the premium)
 *   - Grok gallery images (data/images/*.metadata.json with mode "grok")
 *   - Grok videos in data/video-history.json, including the hidden base image
 *     a text-to-video job generates
 *   - Imagine tool calls in ~/.grok/sessions whose working directory is not a
 *     PortOS portos-grok- scratch dir
 *
 * It does not recover, and will say so:
 *
 *   - per-request prompt size, cached tokens, or reasoning tokens for past
 *     HTTP calls whose usage object was never stored
 *   - the 200k tier for chars/4 estimates
 *   - the subscription allowance percent (the page shows API-equivalent dollars)
 *   - resolution above the default Imagine tier (the CLI does not record it)
 *   - a long turn the interactive scan never billed: only the extra 1× would
 *     be added, so those turns are skipped when there is no watermark
 *
 * chat_history.jsonl has no per-call timestamps. Session-recovered Imagine
 * calls are dated from summary.json updated_at / created_at, else the file mtime.
 * A video tool call that omits duration is billed at 6 seconds and marked estimate.
 *
 * Dry-run is the default. It prints the plan and writes nothing.
 *
 *   node scripts/backfill-grok-usage.js
 *   node scripts/backfill-grok-usage.js --home /path/to/home --data /path/to/data
 *
 * Apply copies data/usage.json (and the interactive-scan watermark, when
 * present) into data/backups/grok-usage-<timestamp>/ and then writes the
 * ledger once. Stop PortOS first. A running server keeps usage.json in memory
 * and will overwrite this file on its next save.
 *
 *   node scripts/backfill-grok-usage.js --apply
 */

import { copyFile, mkdir, readdir, readFile, stat } from 'fs/promises';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { PATHS } from '../server/lib/fileUtils.js';
import { familyForProvider } from '../server/lib/providerFamilies.js';
import { parseGrokTurns } from '../server/lib/providerTranscriptUsage.js';
import { grokUsageProviderIdFromList } from '../server/services/grokMediaUsage.js';
import {
  galleryImageUsageEvent,
  imagineEventsFromGrokSession,
  planGrokUsageRepair,
  videoHistoryUsageEvents,
} from '../server/services/grokUsageRepair.js';
import { addDatedUsage, flushUsageLedger, loadUsage, getUsage } from '../server/services/usage.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function argValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function listDir(path) {
  try {
    return await readdir(path);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function fileMtime(path) {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

async function collectSessions(home) {
  const root = join(home, '.grok', 'sessions');
  const turns = [];
  const media = [];
  for (const dirName of await listDir(root)) {
    let cwd = dirName;
    try { cwd = decodeURIComponent(dirName); } catch { /* keep the raw name */ }
    const cwdDir = join(root, dirName);
    for (const sessionId of await listDir(cwdDir)) {
      const sessionDir = join(cwdDir, sessionId);
      const updatesPath = join(sessionDir, 'updates.jsonl');
      const updatesText = await readFile(updatesPath, 'utf8').catch(() => '');
      if (updatesText) {
        const parsed = parseGrokTurns(updatesText);
        for (const turn of parsed.longTurns || []) turns.push(turn);
      }
      const summary = await readJson(join(sessionDir, 'summary.json'), null);
      const chatPath = join(sessionDir, 'chat_history.jsonl');
      const stamp = Date.parse(summary?.updated_at || summary?.created_at || '')
        || await fileMtime(chatPath)
        || await fileMtime(updatesPath);
      const day = Number.isFinite(stamp) ? new Date(stamp).toISOString().slice(0, 10) : null;
      const chatText = await readFile(chatPath, 'utf8').catch(() => '');
      media.push(...imagineEventsFromGrokSession({
        chatText, updatesText, sessionId, cwd, day,
      }));
    }
  }
  return { turns, media };
}

async function collectGallery(dataDir) {
  const dir = join(dataDir, 'images');
  const media = [];
  for (const name of await listDir(dir)) {
    if (!name.endsWith('.metadata.json')) continue;
    const meta = await readJson(join(dir, name), null);
    const event = galleryImageUsageEvent(meta);
    if (event) media.push(event);
  }
  return media;
}

async function collectVideos(dataDir) {
  const history = await readJson(join(dataDir, 'video-history.json'), []);
  return (Array.isArray(history) ? history : []).flatMap(videoHistoryUsageEvents);
}

async function providerIdFor(dataDir) {
  const stored = await readJson(join(dataDir, 'providers.json'), null);
  const list = Array.isArray(stored) ? stored : (stored?.providers || []);
  const grok = list.filter((provider) => provider && familyForProvider(provider) === 'grok');
  return grokUsageProviderIdFromList(grok.length ? list : []);
}

function printPlan(plan) {
  console.log(`Grok usage repair: ${plan.additions.length} addition(s).`);
  const counts = { turns: 0, images: 0, videos: 0 };
  for (const item of plan.additions) {
    if (item.repairId.startsWith('turn:')) counts.turns += 1;
    else if (item.record.videoSeconds) counts.videos += 1;
    else counts.images += 1;
    console.log(`  ${item.day}  ${item.repairId}  model=${item.record.model || '(default)'}  images=${item.record.images || 0}  videoSeconds=${item.record.videoSeconds || 0}  longIn=${item.record.longTokensIn || 0}`);
  }
  console.log(`Summary: ${counts.turns} long-context turn(s), ${counts.images} image row(s), ${counts.videos} video row(s).`);
  for (const note of plan.notes) console.log(`Note: ${note}`);
  console.log('Not recoverable: past HTTP calls that never stored prompt size, cache, or reasoning; chars/4 estimates; the subscription allowance percent; Imagine resolution above the default tier.');
  console.log('Cache rates re-price themselves when you reload the Usage page. This script does not rewrite those tokens.');
}

async function backup(dataDir) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = join(dataDir, 'backups', `grok-usage-${stamp}`);
  await mkdir(dest, { recursive: true });
  for (const name of ['usage.json', 'usage-interactive-scan.json']) {
    const source = join(dataDir, name);
    try {
      await copyFile(source, join(dest, name));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  return dest;
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const home = argValue(argv, '--home') || homedir();
  const dataDir = argValue(argv, '--data') || join(ROOT, 'data');
  const scan = await readJson(join(dataDir, 'usage-interactive-scan.json'), { watermarks: {} });
  const watermarkMs = typeof scan?.watermarks?.grok === 'number' ? scan.watermarks.grok : null;
  const usage = await readJson(join(dataDir, 'usage.json'), {});
  const sessions = await collectSessions(home);
  const media = [
    ...sessions.media,
    ...await collectGallery(dataDir),
    ...await collectVideos(dataDir),
  ];
  const plan = planGrokUsageRepair({
    turns: sessions.turns,
    media,
    repairIds: Array.isArray(usage.grokRepairIds) ? usage.grokRepairIds : [],
    watermarkMs,
    providerId: await providerIdFor(dataDir),
  });
  printPlan(plan);
  if (!apply) {
    console.log('Dry run. Re-run with --apply after stopping PortOS to write data/usage.json.');
    return;
  }
  if (resolve(dataDir) !== resolve(PATHS.data)) {
    console.error(`❌ --apply writes ${PATHS.data}/usage.json. Re-run without --data, or pass --data ${PATHS.data}.`);
    process.exitCode = 1;
    return;
  }
  if (plan.additions.length === 0) {
    console.log('Nothing to apply.');
    return;
  }
  const copied = await backup(dataDir);
  console.log(`Backed up the ledger to ${copied}`);
  await loadUsage();
  let added = 0;
  for (const item of plan.additions) {
    const wrote = await addDatedUsage(item.day, item.record, { repairId: item.repairId, flush: false });
    if (wrote) added += 1;
  }
  if (added > 0) await flushUsageLedger();
  const ids = getUsage().grokRepairIds || [];
  console.log(`Applied ${added} addition(s). ${ids.length} repair id(s) now on the ledger.`);
}

main().catch((err) => {
  console.error(`❌ Grok usage backfill failed: ${err.message}`);
  process.exitCode = 1;
});
