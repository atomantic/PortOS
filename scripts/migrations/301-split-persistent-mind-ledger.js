/**
 * Move persistent-mind trajectory events out of the ordinary CoS diagnostic
 * ledger. The two streams have different retention contracts and must not
 * consume each other's count budget.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { atomicWrite } from '../../server/lib/fileUtils.js';
import { isPersistentMindEventKind } from '../../server/lib/persistentMindTrajectory.js';

const readOptional = (path) => readFile(path, 'utf8').catch((error) => {
  if (error.code === 'ENOENT') return '';
  throw error;
});

const parseLines = (raw) => raw.split('\n').filter(Boolean).map((line) => {
  try { return { line, event: JSON.parse(line) }; } catch { return { line, event: null }; }
});

const serialize = (entries) => entries.length
  ? `${entries.map(({ event, line }) => event ? JSON.stringify(event) : line).join('\n')}\n`
  : '';

export function splitPersistentMindLedger({ runArchive = '', runActive = '', mindArchive = '', mindActive = '' } = {}) {
  const splitSource = (raw) => parseLines(raw).reduce((result, entry) => {
    const bucket = entry.event && isPersistentMindEventKind(entry.event.kind) ? result.mind : result.ordinary;
    bucket.push(entry);
    return result;
  }, { ordinary: [], mind: [] });
  const archive = splitSource(runArchive);
  const active = splitSource(runActive);
  const existingArchive = parseLines(mindArchive).filter(({ event }) => event && isPersistentMindEventKind(event.kind));
  const existingActive = parseLines(mindActive).filter(({ event }) => event && isPersistentMindEventKind(event.kind));
  const seen = new Set();
  const lastSequence = new Map();
  const prepareMind = (entries) => entries.filter(({ event }) => {
    if (!event?.eventId || seen.has(event.eventId)) return false;
    seen.add(event.eventId);
    return true;
  }).map(({ event }) => {
    const previous = lastSequence.get(event.mindId) ?? null;
    const data = event.data && typeof event.data === 'object' && !Array.isArray(event.data) ? event.data : {};
    const annotated = Object.hasOwn(data, 'previousSequence')
      ? event
      : { ...event, data: { ...data, previousSequence: previous } };
    if (event.mindId && Number.isSafeInteger(event.sequence)) lastSequence.set(event.mindId, event.sequence);
    return { event: annotated };
  });
  const preparedArchive = prepareMind([...existingArchive, ...archive.mind]);
  const preparedActive = prepareMind([...existingActive, ...active.mind]);
  return {
    runArchive: serialize(archive.ordinary),
    runActive: serialize(active.ordinary),
    mindArchive: serialize(preparedArchive),
    mindActive: serialize(preparedActive),
    moved: archive.mind.length + active.mind.length,
  };
}

export default {
  async up({ rootDir }) {
    const cosDir = join(rootDir, 'data', 'cos');
    const paths = {
      runArchive: join(cosDir, 'run-events.1.jsonl'),
      runActive: join(cosDir, 'run-events.jsonl'),
      mindArchive: join(cosDir, 'mind-events.1.jsonl'),
      mindActive: join(cosDir, 'mind-events.jsonl'),
    };
    const values = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, path]) => [key, await readOptional(path)])));
    const result = splitPersistentMindLedger(values);
    if (result.moved === 0) return { updated: 0, reason: 'no-mind-events' };
    // Destination-first is the crash-recovery contract. If a later source
    // rewrite fails, the old line remains and a retry dedupes it against the
    // already-written destination. Source-first could remove the only copy.
    await atomicWrite(paths.mindArchive, result.mindArchive);
    await atomicWrite(paths.mindActive, result.mindActive);
    await atomicWrite(paths.runArchive, result.runArchive);
    await atomicWrite(paths.runActive, result.runActive);
    console.log(`🧠 migration 301: moved ${result.moved} persistent mind event(s) into their own ledger`);
    return { updated: result.moved };
  },
};
