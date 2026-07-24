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
import { buildMainReferencePrompt, buildAnchorPrompt, buildWalkVideoPrompt } from './prompts.js';

const CANDIDATE_RE = /^reference\/candidates\/(.+)\.png$/i;

/**
 * Turn a candidate's generation sidecar into a `{ prompt, designPrompt,
 * source }` result — the stored literal prompt when captured, otherwise a
 * faithful rebuild from the parameters the sidecar did record.
 */
function fromCandidateSidecar(sidecar, name) {
  if (!sidecar) return null;
  if (typeof sidecar.prompt === 'string' && sidecar.prompt) {
    return { prompt: sidecar.prompt, designPrompt: sidecar.designPrompt || null, source: 'candidate' };
  }
  // Pre-capture candidate — rebuild with the builder that produced it.
  const prompt = sidecar.target === 'main'
    ? buildMainReferencePrompt({ name, designPrompt: sidecar.designPrompt, chromaKey: sidecar.chromaKey })
    : buildAnchorPrompt({ name, direction: sidecar.direction || sidecar.target, chromaKey: sidecar.chromaKey });
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
      const main = manifest.mainReference;
      if (main?.path === relPath) {
        // Prefer the frozen candidate's literal prompt; fall back to a rebuild
        // from the manifest's own recorded design prompt + key.
        const stem = candidateStem(main.lockedFrom);
        const fromCandidate = stem ? fromCandidateSidecar(await candidateSidecarFor(recordId, stem), name) : null;
        return fromCandidate || {
          prompt: buildMainReferencePrompt({ name, designPrompt: manifest.designPrompt, chromaKey: manifest.chromaKey }),
          designPrompt: manifest.designPrompt || null,
          source: 'reference-main',
        };
      }
      const anchor = (manifest.anchors || []).find((a) => a.path === relPath);
      if (anchor) {
        const stem = candidateStem(anchor.lockedFrom);
        const fromCandidate = stem ? fromCandidateSidecar(await candidateSidecarFor(recordId, stem), name) : null;
        return fromCandidate || {
          prompt: buildAnchorPrompt({ name, direction: anchor.direction, chromaKey: manifest.chromaKey }),
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
