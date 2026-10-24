/**
 * Apply the Grok usage repair to the server's in-memory ledger.
 *
 * Reconcile on the Usage page calls this from the historical-backfill job, on
 * the same thread that owns usage.json. A separate process writing that file
 * would lose to the server's next save. Repair ids already on the ledger make
 * a repeat a no-op. The on-disk ledger is copied before the first write of a
 * batch that has something to add.
 *
 * The CLI script is a dry-run and stopped-server wrapper around these two
 * functions. Cache-rate corrections are not part of either path: the report
 * prices tokens when it is built.
 */

import { copyFile, mkdir, readdir, readFile, stat } from 'fs/promises';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { PATHS } from '../lib/fileUtils.js';
import { familyForProvider } from '../lib/providerFamilies.js';
import { parseGrokTurns } from '../lib/providerTranscriptUsage.js';
import { grokUsageProviderIdFromList } from './grokMediaUsage.js';
import {
  galleryImageUsageEvent,
  imagineEventsFromGrokSession,
  planGrokUsageRepair,
  summarizeGrokRepairAdditions,
  videoHistoryUsageEvents,
} from './grokUsageRepair.js';
import { addDatedUsage, flushUsageLedger, getUsage, loadUsage } from './usage.js';

const yieldToEventLoop = () => new Promise((done) => setImmediate(done));

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
    try { cwd = decodeURIComponent(dirName); } catch { /* keep the raw directory name */ }
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
      await yieldToEventLoop();
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

async function providerIdFromFile(dataDir) {
  const stored = await readJson(join(dataDir, 'providers.json'), null);
  const list = Array.isArray(stored) ? stored : (stored?.providers || []);
  const grok = list.filter((provider) => provider && familyForProvider(provider) === 'grok');
  return grokUsageProviderIdFromList(grok.length ? list : []);
}

/**
 * Read sessions, the gallery, and video history without touching the ledger.
 * `repairIds` default to the on-disk list so a dry run does not load the
 * server's in-memory copy.
 */
export async function planGrokUsageRepairFromDisk({
  home = homedir(),
  dataDir = PATHS.data,
  repairIds = null,
  providerId = null,
} = {}) {
  const scan = await readJson(join(dataDir, 'usage-interactive-scan.json'), { watermarks: {} });
  const watermarkMs = typeof scan?.watermarks?.grok === 'number' ? scan.watermarks.grok : null;
  const storedIds = repairIds ?? (await readJson(join(dataDir, 'usage.json'), {}))?.grokRepairIds;
  const sessions = await collectSessions(home);
  return planGrokUsageRepair({
    turns: sessions.turns,
    media: [
      ...sessions.media,
      ...await collectGallery(dataDir),
      ...await collectVideos(dataDir),
    ],
    repairIds: Array.isArray(storedIds) ? storedIds : [],
    watermarkMs,
    providerId: providerId || await providerIdFromFile(dataDir),
  });
}

async function backupLedger(dataDir) {
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

/**
 * Plan against the in-memory repair ids and add any missing rows there.
 * Writes only PATHS.data, which is the file the running server will save.
 * @returns {Promise<{ added: number, turns: number, images: number, videos: number,
 *   backedUp: boolean, note: string|null, backupDir: string|null }>}
 */
export async function applyGrokUsageRepair({
  home = homedir(),
  dataDir = PATHS.data,
  providers = null,
  providerId = null,
} = {}) {
  if (resolve(dataDir) !== resolve(PATHS.data)) {
    throw new Error(`Grok usage repair writes ${PATHS.data}/usage.json`);
  }
  await loadUsage();
  const resolvedProviderId = providerId
    || (providers ? grokUsageProviderIdFromList(providers) : await providerIdFromFile(dataDir));
  const plan = await planGrokUsageRepairFromDisk({
    home,
    dataDir,
    repairIds: getUsage().grokRepairIds || [],
    providerId: resolvedProviderId,
  });
  const note = plan.notes[0] || null;
  if (plan.additions.length === 0) {
    return { ...summarizeGrokRepairAdditions([]), backedUp: false, note, backupDir: null };
  }
  const backupDir = await backupLedger(dataDir);
  const written = [];
  for (const item of plan.additions) {
    const wrote = await addDatedUsage(item.day, item.record, { repairId: item.repairId, flush: false });
    if (wrote) written.push(item);
  }
  if (written.length > 0) await flushUsageLedger();
  return { ...summarizeGrokRepairAdditions(written), backedUp: true, note, backupDir };
}
