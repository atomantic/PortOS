import { randomUUID } from 'crypto';
import { findOrCreateUniverseCollection } from './mediaCollections.js';

/**
 * Resolve a universe media collection and assemble the `universeRun` job tag
 * that `universeBuilderCollectionHook` consumes to file a finished render into
 * the universe's "Universe: <name>" bucket (and, when an `entryRef` is present,
 * append it to the source entry's `imageRefs[]`).
 *
 * Provisioning is best-effort: a `findOrCreateUniverseCollection` failure logs
 * `errorContext` and drops the collection portion of the tag (the render still
 * runs, just unfiled). The tag is dropped entirely (returns `undefined`) only
 * when there is nothing left to do — no collection AND no `entryRef`.
 *
 * Callers that batch many renders under one run (universeBuilderRender) provision
 * the collection once and mint a single `runId`, then pass both `collection` and
 * `runId` so each per-item tag reuses them without re-hitting
 * `findOrCreateUniverseCollection`. Single-render callers (base-style probe,
 * character reference sheets) omit both and let the helper provision + mint.
 *
 * @param {object} args
 * @param {string} args.universeId - universe the render belongs to (always tagged).
 * @param {string} [args.universeName] - used to provision/describe the collection
 *   when `collection` is not supplied.
 * @param {string} [args.label] - human label for the run/entry (omitted when falsy).
 * @param {string} [args.category] - collection category (omitted when falsy).
 * @param {object} [args.entryRef] - source-entry pointer so the completion hook can
 *   append the render to that entry's `imageRefs[]`.
 * @param {string} [args.runId] - caller-supplied run id to reuse across a batch;
 *   a fresh one is minted per call when omitted.
 * @param {object|null} [args.collection] - pre-resolved collection (skips provisioning).
 *   Pass `undefined` to provision; an explicit `null` means "already resolved, none".
 * @param {string} [args.errorContext] - prefix for the best-effort provisioning error log.
 * @returns {Promise<object|undefined>} the `universeRun` tag, or `undefined` when there
 *   is no collection and no `entryRef`.
 */
export async function buildUniverseRunTag({
  universeId,
  universeName,
  label,
  category,
  entryRef,
  runId,
  collection,
  errorContext = 'universe collection provision failed',
}) {
  const resolved = collection !== undefined
    ? collection
    : await findOrCreateUniverseCollection({
        universeId,
        universeName,
        description: `Universe Builder renders for "${universeName}"`,
      }).catch((err) => {
        console.error(`❌ ${errorContext}: ${err?.message || err}`);
        return null;
      });

  // Drop the tag entirely only when there's nothing left to do — no collection
  // to file into AND no entry to append to.
  if (!resolved && !entryRef) return undefined;

  return {
    universeId,
    ...(resolved ? { runId: runId || randomUUID(), collectionId: resolved.id } : {}),
    ...(label ? { label } : {}),
    ...(category ? { category } : {}),
    ...(entryRef ? { entryRef } : {}),
  };
}
