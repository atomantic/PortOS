/**
 * Sprites — generation-prompt provenance for any on-disk asset.
 *
 * Resolves "what prompt produced this image?" for a record-relative asset path,
 * so the client's image-preview surfaces (SpriteLightbox, AssetInspector) can
 * show + copy the prompt the way the render-history MediaLightbox does. Covers
 * every image the Sprite Manager generates:
 *
 *   - reference/candidates/<anchor>-candidate-NN.png — the reviewable renders.
 *     Newer candidates persist the literal prompt in their `.generation.json`
 *     sidecar (attach hook); older ones predate that capture, so the prompt is
 *     reconstructed deterministically from the sidecar's designPrompt/direction
 *     /chromaKey via the same builders that generated it.
 *   - reference/<id>-walk-<dir>-vN.png — the locked main + directional anchors.
 *     Resolved through the manifest: prefer the frozen candidate's literal
 *     prompt (`lockedFrom`), else rebuild from the manifest's own designPrompt/
 *     chromaKey.
 *   - grok|runs/<run>/… — walk-animation assets, rebuilt from the run record's
 *     direction + chromaKey (the i2v motion prompt is a pure function of those).
 *
 * Returns `null` for an asset PortOS didn't generate from a prompt (imported
 * atlases, manifests, uploads) so the client simply omits the prompt block.
 * Reconstruction is deterministic and needs no migration — the stored literal
 * is only ever a fidelity upgrade over it, never a correctness requirement.
 */

import { join } from 'path';
import { readJSONFile } from '../../lib/fileUtils.js';
import { spriteDir, resolveSpriteAssetPath, RUN_DIR_MATCH } from './paths.js';
import { getRecord } from './records.js';
import { loadManifest } from './reference.js';
import {
  buildMainReferencePrompt, buildAnchorPrompt, buildWalkVideoPrompt, buildTurnaroundPrompt,
} from './prompts.js';
import { DEFAULT_CHROMA_KEY } from './chromaKey.js';

const CANDIDATE_RE = /^reference\/candidates\/(.+)\.png$/i;

/**
 * Turn a candidate's generation sidecar into a `{ prompt, designPrompt,
 * source }` result — the stored literal prompt when captured, otherwise a
 * faithful rebuild from the parameters the sidecar did record.
 */
function fromCandidateSidecar(sidecar, name, { fromTurnaround = false } = {}) {
  if (!sidecar) return null;
  if (typeof sidecar.prompt === 'string' && sidecar.prompt) {
    return { prompt: sidecar.prompt, designPrompt: sidecar.designPrompt || null, source: 'candidate' };
  }
  // Pre-capture candidate — rebuild with the builder that produced it.
  const prompt = sidecar.target === 'turnaround'
    ? buildTurnaroundPrompt({ name, designPrompt: sidecar.designPrompt, chromaKey: sidecar.chromaKey })
    : sidecar.target === 'main'
      ? buildMainReferencePrompt({ name, designPrompt: sidecar.designPrompt, chromaKey: sidecar.chromaKey, fromTurnaround })
      : buildAnchorPrompt({ name, direction: sidecar.direction || sidecar.target, chromaKey: sidecar.chromaKey, fromTurnaround });
  return { prompt, designPrompt: sidecar.designPrompt || null, source: 'candidate-reconstructed' };
}

async function candidateSidecarFor(recordId, candidateStem) {
  return readJSONFile(join(spriteDir(recordId), 'reference', 'candidates', `${candidateStem}.generation.json`), null);
}

/**
 * The generation prompt for a record-relative sprite asset, or `null` when the
 * asset has no prompt provenance. `relPath` is confined to the record dir
 * (throws on traversal) before any file read.
 */
export async function resolveSpriteAssetPrompt(recordId, relPath) {
  // Confinement + id validity gate (throws on escape / bad id) before I/O.
  resolveSpriteAssetPath(recordId, relPath);
  const record = await getRecord(recordId);
  if (!record) return null;
  const name = record.name;

  // 1. Reviewable candidate — its own generation sidecar.
  const cand = CANDIDATE_RE.exec(relPath);
  if (cand) {
    return fromCandidateSidecar(await candidateSidecarFor(recordId, cand[1]), name);
  }

  // 2. Locked main / directional anchor — resolved through the manifest.
  if (/^reference\//i.test(relPath)) {
    const manifest = await loadManifest(recordId);
    if (manifest) {
      // Everything below the sheet was derived from it (#2979), so a rebuild
      // must use the turnaround-aware copy or it won't match what was sent.
      const derived = { fromTurnaround: manifest.turnaround?.locked === true };
      const turnaround = manifest.turnaround;
      // `manifest.chromaKey` is the key FROZEN at a lock — which, when
      // auto-selected (user didn't pin), differs from the key the artifact that
      // TRIGGERED that selection was generated against: it was rendered before
      // the key existed, so its prompt embedded the default. Exactly one lock
      // per character freezes the key — the turnaround's on a turnaround-first
      // record, the main's on a legacy one (including a backfilled sheet, which
      // locks later and inherits) — so compare lock times to find it.
      const wasFreezer = (artifact) => {
        const other = artifact === turnaround ? manifest.mainReference : turnaround;
        return !other?.lockedAt || !artifact?.lockedAt || artifact.lockedAt <= other.lockedAt;
      };
      const renderKey = (artifact) => (
        manifest.chromaKeyAutoSelected && wasFreezer(artifact) ? DEFAULT_CHROMA_KEY : manifest.chromaKey
      );
      if (turnaround?.path === relPath) {
        const stem = candidateStem(turnaround.lockedFrom);
        const fromCandidate = stem ? fromCandidateSidecar(await candidateSidecarFor(recordId, stem), name) : null;
        return fromCandidate || {
          prompt: buildTurnaroundPrompt({
            name,
            designPrompt: manifest.designPrompt,
            chromaKey: renderKey(turnaround),
          }),
          designPrompt: manifest.designPrompt || null,
          source: 'reference-turnaround',
        };
      }
      const main = manifest.mainReference;
      if (main?.path === relPath) {
        // Prefer the frozen candidate's literal prompt; fall back to a rebuild
        // from the manifest's own recorded design prompt + key.
        const stem = candidateStem(main.lockedFrom);
        const fromCandidate = stem ? fromCandidateSidecar(await candidateSidecarFor(recordId, stem), name, derived) : null;
        // Fallback (source candidate sidecar gone): rebuild from the manifest.
        return fromCandidate || {
          prompt: buildMainReferencePrompt({
            name,
            designPrompt: manifest.designPrompt,
            chromaKey: renderKey(main),
            ...derived,
          }),
          designPrompt: manifest.designPrompt || null,
          source: 'reference-main',
        };
      }
      const anchor = (manifest.anchors || []).find((a) => a.path === relPath);
      if (anchor) {
        const stem = candidateStem(anchor.lockedFrom);
        const fromCandidate = stem ? fromCandidateSidecar(await candidateSidecarFor(recordId, stem), name, derived) : null;
        return fromCandidate || {
          // An anchor always locks after the key is frozen, so the frozen key
          // is what its prompt embedded — no default-key caveat here.
          prompt: buildAnchorPrompt({ name, direction: anchor.direction, chromaKey: manifest.chromaKey, ...derived }),
          designPrompt: null,
          source: 'reference-anchor',
        };
      }
    }
  }

  // 3. Walk-animation asset — rebuild the i2v motion prompt from the run record.
  const run = RUN_DIR_MATCH.exec(relPath);
  if (run) {
    const runRecord = await readJSONFile(join(spriteDir(recordId), run[0], 'animation-run.json'), null);
    if (runRecord?.direction) {
      return {
        prompt: typeof runRecord.prompt === 'string' && runRecord.prompt
          ? runRecord.prompt
          : buildWalkVideoPrompt({ name, direction: runRecord.direction, chromaKey: runRecord.chromaKey }),
        designPrompt: null,
        source: 'walk',
      };
    }
  }

  return null;
}

// `reference/candidates/<stem>.png` → `<stem>`; anything else → null.
function candidateStem(candidatePath) {
  const m = typeof candidatePath === 'string' ? CANDIDATE_RE.exec(candidatePath) : null;
  return m ? m[1] : null;
}
