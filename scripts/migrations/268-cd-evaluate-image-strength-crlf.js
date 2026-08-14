/**
 * Re-attempt migration 002's `imageStrength` backfill on installs whose
 * cd-evaluate.md has CRLF line endings.
 *
 * 002 matches its insertion points against anchor strings that end in a bare
 * `\n`. On an install where `data/prompts/stages/cd-evaluate.md` carries CRLF
 * line endings — a Windows checkout, or a copy that round-tripped through an
 * editor that converts on save — none of those anchors match, so 002 logs
 * "anchors don't match … hand-merge from data.reference/" and returns without
 * writing. The runner then records it as applied, so it never retries, and the
 * template is stuck a version behind forever: the evaluator never sees the
 * per-scene imageStrength knob and cannot adjust it on a retry.
 *
 * `_lib.js`'s hash-driven path already normalizes newlines before comparing
 * (see its `md5` helper) — 002 predates that and does its own hand-rolled
 * anchor matching, which is where the gap is.
 *
 * This migration does what 002 does, but matches against a newline-normalized
 * copy of the template and writes the result back in the file's ORIGINAL
 * newline style, so a Windows install keeps its CRLF file CRLF. It is a no-op
 * on an install 002 already handled (the block is present) and on a
 * hand-customized template whose anchors genuinely don't match.
 *
 * Idempotent — re-runs are a no-op once the block is present.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const TEMPLATE_REL_PATH = 'data/prompts/stages/cd-evaluate.md';

// Same anchors and payloads as 002, spelled with LF. Matching happens against a
// normalized copy, so these cover CRLF and bare-CR files too.
const ANCHOR_BEFORE_BLOCK = '- Strategy: {{scene.strategy}}\n';
const ANCHOR_AFTER_BLOCK = '- Retry count: {{scene.retryCount}} (max 3)\n';
const NEW_BLOCK_LINES =
  '{{#scene.hasImageStrength}}- Image strength: {{scene.imageStrength}} (0–1; higher = stick closer to source image){{/scene.hasImageStrength}}\n' +
  '{{^scene.hasImageStrength}}- Image strength: default (continuation: 0.85; otherwise renderer default){{/scene.hasImageStrength}}\n';

const RETRY_OLD = '**If the render misses the mark and retries are still available** (`retryCount < 3`): tweak the prompt and request a re-render. The server will run the new render and then send you back here for another evaluation.';
const RETRY_NEW = '**If the render misses the mark and retries are still available** (`retryCount < 3`): tweak the prompt and request a re-render. The server will run the new render and then send you back here for another evaluation. You may also adjust `imageStrength` (0.0–1.0) on i2v scenes — drop it (e.g. 0.85 → 0.6) when the seed image is dominating and the prompt isn\'t expressed; raise it (e.g. → 0.95) when continuation drifted too far from the prior scene. Omit `imageStrength` from the PATCH to leave it unchanged.';

/** Collapse CRLF and bare CR to LF so anchors spelled with `\n` can match. */
const toLf = (text) => text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

/**
 * The newline style to write back with. A file that uses CRLF anywhere is
 * treated as a CRLF file — mixing styles in one template would be worse than
 * preserving the dominant one.
 */
const usesCrlf = (text) => text.includes('\r\n');

/**
 * Pure core, exported for the test: apply both insertions to `original`,
 * returning the rewritten text or `null` when nothing changed.
 */
export function applyImageStrengthBackfill(original, { log = () => {} } = {}) {
  const crlf = usesCrlf(original);
  let next = toLf(original);
  let changed = false;

  if (!next.includes('{{#scene.hasImageStrength}}')) {
    const anchorPair = ANCHOR_BEFORE_BLOCK + ANCHOR_AFTER_BLOCK;
    if (next.includes(anchorPair)) {
      next = next.replace(anchorPair, ANCHOR_BEFORE_BLOCK + NEW_BLOCK_LINES + ANCHOR_AFTER_BLOCK);
      changed = true;
    } else {
      log(`⚠️ ${TEMPLATE_REL_PATH}: scene-context anchors don't match the pre-update template — skipping the imageStrength block insertion. Hand-merge from data.reference/ if needed.`);
    }
  }

  if (!next.includes('adjust `imageStrength`')) {
    if (next.includes(RETRY_OLD)) {
      next = next.replace(RETRY_OLD, RETRY_NEW);
      changed = true;
    } else {
      log(`⚠️ ${TEMPLATE_REL_PATH}: retry-branch sentence doesn't match the pre-update template — skipping the imageStrength guidance extension. Hand-merge from data.reference/ if needed.`);
    }
  }

  if (!changed) return null;
  return crlf ? next.replace(/\n/g, '\r\n') : next;
}

export default {
  async up({ rootDir }) {
    const templatePath = join(rootDir, TEMPLATE_REL_PATH);
    const original = await readFile(templatePath, 'utf-8').catch((err) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (original == null) {
      console.log(`📄 ${TEMPLATE_REL_PATH} not present — skipping (fresh install copies it from data.reference)`);
      return;
    }

    const next = applyImageStrengthBackfill(original, { log: (msg) => console.log(msg) });
    if (next == null) {
      console.log(`✅ ${TEMPLATE_REL_PATH}: already up-to-date, no changes needed`);
      return;
    }
    await writeFile(templatePath, next);
    console.log(`📝 ${TEMPLATE_REL_PATH}: backfilled imageStrength surfacing (CRLF-tolerant re-run of 002)`);
  },
};
