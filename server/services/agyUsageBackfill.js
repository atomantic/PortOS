/**
 * Apply the Antigravity usage repair to the server's in-memory ledger.
 *
 * Reconcile on the Usage page calls this from the historical-backfill job, on
 * the same thread that owns usage.json. Repair ids already on the ledger make
 * a repeat a no-op. The on-disk ledger is copied before the first write of a
 * batch that has something to add.
 */

import { copyFile, mkdir, readdir, readFile } from 'fs/promises';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { PATHS } from '../lib/fileUtils.js';
import { familyForProvider } from '../lib/providerFamilies.js';
import { agyUsageProviderIdFromList } from './agyMediaUsage.js';
import {
  galleryAgyImageUsageEvent,
  imagineEventsFromAgyTranscript,
  planAgyUsageRepair,
  summarizeAgyRepairAdditions,
} from './agyUsageRepair.js';
import { addDatedUsage, flushUsageLedger, getUsage, loadUsage } from './usage.js';
import { listAgyConversations } from './usageReconciler.js';

const yieldToEventLoop = () => new Promise((done) => setImmediate(done));

const faultLabel = (err) => {
  if (err?.code) return String(err.code);
  return String(err?.message || err?.name || 'error').replace(/[\r\n]+/g, ' ');
};

const oneLine = (value) => String(value ?? '').replace(/[\r\n]+/g, ' ');

async function readJson(path, fallback, { strict = false, label = 'file' } = {}) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    if (strict) throw err;
    console.warn(`⚠️ Antigravity usage repair skipped unreadable ${label} (${faultLabel(err)})`);
    return fallback;
  }
}

async function listNames(dir) {
  try {
    return await readdir(dir);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`⚠️ Antigravity usage repair skipped a directory (${faultLabel(err)})`);
    }
    return [];
  }
}

async function collectGallery(dataDir) {
  const dir = join(dataDir, 'images');
  const media = [];
  for (const name of await listNames(dir)) {
    if (!name.endsWith('.metadata.json')) continue;
    try {
      const meta = await readJson(join(dir, name), null, { label: oneLine(name) });
      const event = galleryAgyImageUsageEvent(meta);
      if (event) media.push(event);
    } catch (err) {
      console.warn(`⚠️ Antigravity usage repair skipped gallery file ${oneLine(name)} (${faultLabel(err)})`);
    }
  }
  return media;
}

async function collectSessions(home) {
  const root = join(home, '.gemini', 'antigravity-cli');
  const media = [];
  let conversations;
  try {
    conversations = await listAgyConversations(root);
  } catch {
    return media;
  }
  for (const conversation of conversations) {
    try {
      const transcriptPath = join(root, 'brain', conversation.conversationId, '.system_generated', 'logs', 'transcript.jsonl');
      const text = await readFile(transcriptPath, 'utf8').catch(() => '');
      if (text) {
        const events = imagineEventsFromAgyTranscript({
          transcriptText: text,
          sessionId: conversation.conversationId,
          cwd: conversation.workspace,
          day: conversation.timestamp ? new Date(conversation.timestamp).toISOString().slice(0, 10) : null,
        });
        media.push(...events);
      }
    } catch {
      // One unreadable session must not abort the scan
    }
    await yieldToEventLoop();
  }
  return media;
}

async function providerIdFromFile(dataDir) {
  const stored = await readJson(join(dataDir, 'providers.json'), null, { label: 'providers.json' });
  const list = Array.isArray(stored)
    ? stored
    : (Array.isArray(stored?.providers) ? stored.providers : Object.values(stored?.providers || {}));
  const agy = list.filter((provider) => provider && familyForProvider(provider) === 'agy');
  return agyUsageProviderIdFromList(agy.length ? list : []);
}

/**
 * Read the gallery and brain sessions without touching the ledger.
 */
export async function planAgyUsageRepairFromDisk({
  home = homedir(),
  dataDir = PATHS.data,
  repairIds = null,
  providerId = null,
} = {}) {
  const storedIds = repairIds ?? (await readJson(join(dataDir, 'usage.json'), {}, { strict: true }))?.grokRepairIds;
  const gallery = await collectGallery(dataDir);
  const sessionMedia = await collectSessions(home);
  return planAgyUsageRepair({
    media: [...gallery, ...sessionMedia],
    repairIds: Array.isArray(storedIds) ? storedIds : [],
    providerId: providerId || await providerIdFromFile(dataDir),
  });
}

async function backupLedger(dataDir) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = join(dataDir, 'backups', `agy-usage-${stamp}`);
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
 * @returns {Promise<{ added: number, images: number, backedUp: boolean, note: string|null, backupDir: string|null }>}
 */
export async function applyAgyUsageRepair({
  home = homedir(),
  dataDir = PATHS.data,
  providers = null,
  providerId = null,
} = {}) {
  if (resolve(dataDir) !== resolve(PATHS.data)) {
    throw new Error(`Antigravity usage repair writes ${PATHS.data}/usage.json`);
  }
  await loadUsage();
  const resolvedProviderId = providerId
    || (providers ? agyUsageProviderIdFromList(providers) : await providerIdFromFile(dataDir));
  const plan = await planAgyUsageRepairFromDisk({
    home,
    dataDir,
    repairIds: getUsage().grokRepairIds || [],
    providerId: resolvedProviderId,
  });
  const note = plan.notes[0] || null;
  if (plan.additions.length === 0) {
    return { ...summarizeAgyRepairAdditions([]), backedUp: false, note, backupDir: null };
  }
  const backupDir = await backupLedger(dataDir);
  const written = [];
  for (const item of plan.additions) {
    const wrote = await addDatedUsage(item.day, item.record, { repairId: item.repairId, flush: false });
    if (wrote) written.push(item);
  }
  if (written.length > 0) await flushUsageLedger();
  return { ...summarizeAgyRepairAdditions(written), backedUp: true, note, backupDir };
}
