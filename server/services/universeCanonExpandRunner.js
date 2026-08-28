/**
 * The shared shell every universe canon expand runs inside.
 *
 * `universeCharacterExpand.js` and `universeCanonEntryExpand.js` differ only in
 * their prompt template, the variables it takes, and the merge that applies the
 * response. Everything around that is the same delicate sequence, and it is the
 * part with the contracts worth stating once:
 *
 *   1. Locked entries are skipped BEFORE the LLM call — a locked entry is
 *      protected from every AI rewrite path, and spending a provider round-trip
 *      to discover that is pure waste.
 *   2. The merge is re-derived INSIDE the write queue against the freshest
 *      persisted universe, not against the copy read before the call. A user
 *      edit (or another LLM call) that lands during a multi-second round-trip
 *      would otherwise be silently overwritten.
 *   3. The lock is re-checked in that same mutator, because it can be set during
 *      the round-trip. That case returns `locked: true` rather than "nothing to
 *      fill", so the UI shows the same Locked badge it would have shown had the
 *      lock been set a second earlier.
 *
 * When these lived in both services they had already drifted (one guarded the
 * post-write read, the other dereferenced it bare). One copy, one contract.
 */

import { getUniverse, updateUniverse } from './universeBuilder.js';
import { runPromptRefineRaw } from './pipeline/refineHelpers.js';
import { ServerError } from '../lib/errorHandler.js';
import { BIBLE_FIELD } from '../lib/storyBible.js';
import { shortId } from '../lib/fileUtils.js';

/**
 * Run one canon entry through its expand prompt and merge the result.
 *
 * @param {object} args
 * @param {string} args.universeId
 * @param {string} args.kind            canon kind — picks the universe array via `BIBLE_FIELD`
 * @param {string} args.entryId
 * @param {string} args.templateName    prompt stage to run
 * @param {(ctx: {universe: object, target: object, peers: object[]}) => object} args.buildVariables
 * @param {(target: object, content: object) => {merged: object, updatedFields: string[]}} args.applyMerge
 * @param {object} [args.options]       `{ providerId, model }` overrides
 * @param {object} [args.emptyError]    `{ code, message }` for an empty LLM payload
 * @returns {Promise<{universe, entry, updatedFields, locked?, rationale?, runId?, providerId?, model?}>}
 */
export async function runCanonEntryExpand({
  universeId, kind, entryId, templateName, buildVariables, applyMerge, options = {}, emptyError,
}) {
  const field = BIBLE_FIELD[kind];
  const universe = await getUniverse(universeId);
  const list = Array.isArray(universe[field]) ? universe[field] : [];
  const idx = list.findIndex((e) => e.id === entryId);
  if (idx < 0) {
    throw new ServerError(`${kind} ${entryId} not found in universe`, {
      status: 404, code: 'UNIVERSE_CANON_NOT_FOUND',
    });
  }
  const target = list[idx];
  if (target.locked === true) {
    return { universe, entry: target, locked: true, updatedFields: [] };
  }

  // logTag: null — the context-rich line is emitted AFTER the merge below, where
  // the field count is known.
  const { content, rationale, runId, providerId, model } = await runPromptRefineRaw({
    templateName,
    variables: buildVariables({ universe, target, peers: list.filter((_, i) => i !== idx) }),
    options: { providerId: options.providerId, model: options.model, effort: options.effort },
    source: templateName,
    logTag: null,
    emptyError,
  });

  let updatedFields = [];
  let lockedDuringRender = false;
  const updated = await updateUniverse(universeId, (latest) => {
    const latestList = Array.isArray(latest[field]) ? latest[field] : [];
    const latestIdx = latestList.findIndex((e) => e.id === entryId);
    if (latestIdx < 0) return null;
    if (latestList[latestIdx].locked === true) {
      lockedDuringRender = true;
      return null;
    }
    const { merged, updatedFields: fields } = applyMerge(latestList[latestIdx], content);
    updatedFields = fields;
    if (fields.length === 0) return null;
    return { [field]: latestList.map((e, i) => (i === latestIdx ? merged : e)) };
  });

  const latestEntry = (updated?.[field] || []).find((e) => e.id === entryId) || target;
  const result = { universe: updated || universe, entry: latestEntry, rationale, runId, providerId, model };
  if (lockedDuringRender) return { ...result, locked: true, updatedFields: [] };
  if (updatedFields.length > 0) {
    console.log(`✨ Universe ${kind} expand — universe=${shortId(universeId)} entry=${shortId(entryId)} fields=${updatedFields.length} runId=${shortId(runId)}`);
  }
  return { ...result, updatedFields };
}
