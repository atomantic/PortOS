/**
 * Open MiniMax H3 up to image-to-video and FFLF on existing registries.
 *
 * H3 shipped as `supportedModes: ['text']` because PortOS only drove the port's
 * `t2va` path. The same pinned runtime already implements `fl2va` keyframe
 * conditioning, so `scripts/generate_minimax_h3.py` now forwards
 * `--image`/`--anchor` pairs and the entry advertises image + fflf.
 *
 * Two registry fields have to move together:
 *   - `supportedModes` gains 'image' and 'fflf' (the model picker and both
 *     server mode gates read it);
 *   - `requiredWeights[0].files` gains the seven `FL2VA/processor/*` files.
 *     Keyframes run through Qwen3-VL's AutoProcessor, which reads the
 *     `processor/` directory — `tokenizer/` alone is not enough, and a render
 *     that reaches the helper without them dies on a cache miss ~83 GB into
 *     loading. The vision tower's own weights need no new download: they live
 *     in shard 14, which the entry already pulls.
 *
 * `data/media-models.json` is gitignored runtime state and is not a
 * JSON_MERGE_TARGET, so a fresh install gets this from
 * data.reference/media-models.json while existing installs need this patch.
 *
 * Idempotent, and conservative about customization: the mode list is only
 * rewritten when it is still exactly the shipped `['text']`, and each processor
 * file is appended only when absent. An entry a user re-pointed at a different
 * repo/revision is left alone entirely — its files may not exist there.
 */

import { readMediaRegistry, writeMediaRegistry } from './_lib.js';

const REL_PATH = 'data/media-models.json';
const H3_ID = 'minimax_h3_8bit';
const SHIPPED_REPO = 'pipenetwork/MiniMax-H3-MLX-8bit';
const SHIPPED_CHECKPOINT_REPO = 'MiniMaxAI/MiniMax-H3';
const NEW_SHIPPED_MODES = ['text', 'image', 'fflf'];
const PROCESSOR_FILES = [
  'FL2VA/processor/chat_template.json',
  'FL2VA/processor/merges.txt',
  'FL2VA/processor/preprocessor_config.json',
  'FL2VA/processor/tokenizer.json',
  'FL2VA/processor/tokenizer_config.json',
  'FL2VA/processor/video_preprocessor_config.json',
  'FL2VA/processor/vocab.json',
];

export default {
  async up({ rootDir }) {
    const { ok, config, entries: mlxEntries, path } = await readMediaRegistry({ rootDir });
    if (!ok) return;

    const entry = mlxEntries.find((m) => m?.id === H3_ID);
    if (!entry) {
      console.log(`✅ ${REL_PATH}: no '${H3_ID}' entry — user removed it, nothing to migrate`);
      return;
    }
    if (entry.repo !== SHIPPED_REPO) {
      console.log(`✅ ${REL_PATH}: '${H3_ID}' points at ${entry.repo} — user-repointed, leaving it alone`);
      return;
    }

    let changed = false;
    // Only rewrite a mode list that is still exactly the shipped `['text']` —
    // anything else is the user's own narrowing and stays theirs.
    if (entry.supportedModes?.length === 1 && entry.supportedModes[0] === 'text') {
      entry.supportedModes = [...NEW_SHIPPED_MODES];
      changed = true;
    }

    const checkpoint = Array.isArray(entry.requiredWeights) ? entry.requiredWeights[0] : null;
    if (checkpoint?.repo === SHIPPED_CHECKPOINT_REPO && Array.isArray(checkpoint.files)) {
      // Insert ahead of the tokenizer block so the stored order matches the
      // shipped seed — the two files are otherwise byte-compared by eye during
      // support, and a reordered list reads as drift.
      const anchor = checkpoint.files.findIndex((file) => file === 'FL2VA/tokenizer/merges.txt');
      const missing = PROCESSOR_FILES.filter((file) => !checkpoint.files.includes(file));
      if (missing.length > 0) {
        if (anchor >= 0) checkpoint.files.splice(anchor, 0, ...missing);
        else checkpoint.files.push(...missing);
        changed = true;
      }
    }

    if (changed) {
      await writeMediaRegistry(path, config);
      console.log(`📝 ${REL_PATH}: enabled MiniMax H3 image-to-video + FFLF (added the Qwen3-VL processor files)`);
    } else {
      console.log(`✅ ${REL_PATH}: MiniMax H3 already keyframe-capable, no changes`);
    }
  },
};
