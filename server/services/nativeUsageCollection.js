/**
 * Collect native usage into the store and report from it (#15255). A source whose size
 * and mtime are unchanged costs one stat, however old it is; a changed one is re-read
 * whole and replaces only its own row; a deleted one keeps its row and still counts,
 * because deletion is retention rather than restated usage. Staleness comes only from
 * these file facts: a date cut-off would miss a resumed month-old session.
 *
 * Reads local files and writes the store. No inference, no peer and no account access.
 */
import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { foldNativeCoverage } from '../lib/nativeUsageSourceFold.js';
import { canonicalStringify } from '../lib/objects.js';
import { getNativeTranscriptCoverage } from './nativeTranscriptCoverage.js';
import { getNativeAgyUsageCoverage } from './nativeAgyUsageCoverage.js';
import { getNativeGrokUsageCoverage } from './nativeGrokUsageCoverage.js';
import { listNativeUsageSourceFacts, loadNativeUsageSourceProjections, requestNativeUsageSourceReread, saveNativeUsageSource } from './nativeUsageStore.js';

// Bump one when its reader's output changes: that family's sources that still exist
// are re-read. A row whose file is gone is never re-read, so a validator stays listed
// in SUPPORTED_VALIDATORS for as long as the readers can fold its projection shape.
export const NATIVE_USAGE_SOURCE_VALIDATORS = Object.freeze({
  claude: 'claude-retained-messages/1', grok: 'grok-persisted-turns/1', agy: 'agy-cli-sqlite-v1/1',
});
const SUPPORTED_VALIDATORS = Object.freeze({
  claude: [NATIVE_USAGE_SOURCE_VALIDATORS.claude], grok: [NATIVE_USAGE_SOURCE_VALIDATORS.grok], agy: [NATIVE_USAGE_SOURCE_VALIDATORS.agy],
});

const sourceKeyOf = (family, parts) => createHash('sha256').update(canonicalStringify(['portos-native-source/1', family, parts])).digest('hex');

/** What a reader uses to skip unchanged sources, save finished ones and load the rest. */
async function createSourceTracker(family) {
  const validator = NATIVE_USAGE_SOURCE_VALIDATORS[family];
  const known = new Map((await listNativeUsageSourceFacts(family)).map(row => [row.sourceKey, row]));
  const seen = new Set();
  const stats = { unchanged: 0, saved: 0 };
  let saveFailure = null;
  return {
    stats,
    async check(parts, path, { dirty = false } = {}) {
      const facts = await lstat(path, { bigint: true }).catch(() => null);
      if (!facts?.isFile()) return null;
      const sourceKey = sourceKeyOf(family, parts);
      seen.add(sourceKey);
      const current = { sourceKey, sizeBytes: String(facts.size), mtimeNs: String(facts.mtimeNs) };
      const prior = known.get(sourceKey);
      if (!dirty && prior && !prior.rereadRequested && prior.validator === validator
        && prior.sizeBytes === current.sizeBytes && prior.mtimeNs === current.mtimeNs) {
        stats.unchanged++;
        return null;
      }
      return current;
    },
    // Reader walks treat a throw as an unreadable file, which would hide a store fault.
    async save(current, projection) {
      await saveNativeUsageSource({ family, ...current, validator, projection })
        .then(() => { stats.saved++; })
        .catch(error => { saveFailure ??= error; });
    },
    /** Folds each stored source's coverage into the run's, and returns the rows for the
     * reader to fold its records. Call once, after the walk. */
    async load(coverage) {
      if (saveFailure) throw saveFailure;
      const rows = await loadNativeUsageSourceProjections(family);
      const stored = rows.filter(row => SUPPORTED_VALIDATORS[family].includes(row.validator));
      const findings = [];
      if (stored.length !== rows.length) findings.push('stored-projection-unsupported');
      // A walk that stopped or failed cannot tell a deleted source from an unvisited one.
      if (!coverage.stoppedEarly && !coverage.unreadableFiles && stored.some(({ sourceKey }) => !seen.has(sourceKey))) findings.push('collected-sources-detached');
      if (stored.length) coverage.missingSource = false;
      for (const { projection } of stored) foldNativeCoverage(coverage, projection.coverage);
      return { stored, findings };
    },
  };
}

// Overlapping runs would re-read the same changed files and race their rows.
const serialized = createFileWriteQueue();

/** One bounded run across all three file families, which share its deadline. A family
 * reached after the deadline stops at once and reports what it already holds.
 */
export function collectNativeUsageSources({ limits }) {
  const home = homedir();
  return serialized(async () => {
    const deadline = Date.now() + limits.milliseconds;
    const claude = await createSourceTracker('claude');
    const agy = await createSourceTracker('agy');
    const grok = await createSourceTracker('grok');
    const transcripts = {
      claude: await getNativeTranscriptCoverage('claude', { home, limits, deadline, includeRecords: true, sources: claude }),
      agy: await getNativeAgyUsageCoverage({ home, limits, deadline, sources: agy }),
      grok: await getNativeGrokUsageCoverage({ home, limits, deadline, sources: grok }),
    };
    return { transcripts, stats: { unchanged: claude.stats.unchanged + agy.stats.unchanged + grok.stats.unchanged,
      saved: claude.stats.saved + agy.stats.saved + grok.stats.saved } };
  });
}

/** Explicit recovery for an in-place rewrite that kept size and mtime. Sources still on
 * disk are read again by the next collections until each finishes; none loses its row.
 */
export const requestNativeUsageRebuild = () => serialized(() => requestNativeUsageSourceReread());
