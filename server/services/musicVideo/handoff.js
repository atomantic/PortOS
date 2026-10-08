import { shotActionPrompt } from '../../lib/musicVideoActionContract.js';
import { musicVideoCreativeContext } from '../../lib/musicVideoCreativeContext.js';
import { MOTION_CONTINUITY_CLAUSE } from '../../lib/musicVideoMotion.js';
/**
 * Music Video external-asset handoff (#8965) — provider-neutral export/import
 * for tools PortOS does not drive, such as Midjourney.
 *
 * PortOS never automates the external tool (Midjourney's guidelines prohibit
 * unauthorized automation and it has no general public API): the director
 * exports a manifest of per-scene prompts and reference files, generates by
 * hand, then imports the downloaded files through the ordinary gallery upload
 * routes. Scene association survives the round trip through a FILE TAG
 * (`S03-1a2b3c4d`) the manifest assigns each scene: a downloaded file whose
 * name carries the tag is matched back to its exact scene by the scene id the
 * tag encodes — the `S03` order prefix is cosmetic, so reordering the board
 * between export and import can't misfile an asset.
 *
 * The manifest is built from an explicit field allowlist, so machine-local
 * render pins, renderer settings and server paths never leave the install.
 */

import { readFile } from 'fs/promises';
import { resolveGalleryImage } from '../../lib/pathSafety.js';
import { createZip } from '../../lib/zipWriter.js';

export const HANDOFF_FORMAT = 'portos.music-video.handoff';
export const HANDOFF_VERSION = 1;

const sceneShortId = (sceneId) => String(sceneId || '')
  .replace(/^mvs-/, '')
  .replace(/[^a-z0-9]/gi, '')
  .slice(0, 8)
  .toLowerCase();

/** The tag a scene's externally generated files carry in their filename. */
function sceneFileTag(scene, index) {
  return `S${String(index + 1).padStart(2, '0')}-${sceneShortId(scene.sceneId)}`;
}

// Up to eight id characters: a normal `mvs-<uuid>` scene yields exactly eight,
// but a short hand-authored id yields fewer and must still round-trip.
const FILE_TAG_RE = /(?:^|[^a-z0-9])s\d{1,3}[-_]([a-z0-9]{1,8})(?![a-z0-9])/gi;

/**
 * Resolve an imported file's original name to the scene whose tag it carries.
 * Returns null when the name carries no tag, a tag no scene owns, or tags for
 * two different scenes — an ambiguous file is never guessed onto a scene.
 */
export function matchSceneByFileTag(scenes, originalName) {
  if (typeof originalName !== 'string' || !originalName) return null;
  const byShort = new Map();
  for (const scene of scenes || []) {
    const short = sceneShortId(scene.sceneId);
    // Two scenes sharing a short id make that tag ambiguous for both.
    byShort.set(short, byShort.has(short) ? null : scene.sceneId);
  }
  const matched = new Set();
  for (const [, short] of originalName.matchAll(FILE_TAG_RE)) {
    const sceneId = byShort.get(short.toLowerCase());
    if (sceneId) matched.add(sceneId);
  }
  return matched.size === 1 ? [...matched][0] : null;
}

/**
 * The project-wide visual direction appended to generated prompts — palette
 * and camera rules from the visual spec. Kept in step with `visualDirection`
 * in client/src/hooks/useMusicVideoSceneMedia.js, which composes the same
 * suffix for PortOS's own renders.
 *
 * Typography is deliberately excluded from this suffix (#8992): it belongs
 * to the separately composited text layer (#8984), not the image/video
 * prompt handed to an external tool. `visualSpec.typography` still exports
 * on the manifest below for the typography lane and other external tools.
 */
export function visualDirection(spec) {
  if (!spec) return '';
  return [
    spec.palette?.length ? `color palette ${spec.palette.join(' ')}` : '',
    spec.cameraRules?.trim() ? `camera: ${spec.cameraRules.trim()}` : '',
  ].filter(Boolean).join('; ');
}

// `clause` is the scene's applied treatment direction (#8980) — the composition
// constraints for a frame or a motion prompt. Same order as the client's
// buildFramePrompt/buildShotPrompt.
// A motion prompt (`motion: true`) omits the mood-board look (the i2v model
// starts from the reference frame, which already carries it) and pins the
// frame's lighting for the length of the take.
function composePrompt(primary, fallback, project, clause, { motion = false } = {}) {
  return [
    primary?.trim() || fallback?.trim() || '',
    project.concept?.style?.trim() || '',
    musicVideoCreativeContext(project.concept, { moodBoard: !motion }),
    visualDirection(project.visualSpec),
    clause?.trim() || '',
    motion ? MOTION_CONTINUITY_CLAUSE : '',
  ].filter(Boolean).join(', ');
}

/** A scene's composed reference-frame prompt (also the server-owned production run's, #9066). */
export const sceneFramePrompt = (project, scene) => [composePrompt(scene.framePrompt, scene.prompt, project, scene.direction?.frameClause), shotActionPrompt(project, scene, { frame: true })].filter(Boolean).join('\n');

/** A scene's composed shot (motion) prompt. */
export const sceneShotPrompt = (project, scene, options = {}) => [composePrompt(scene.prompt, scene.framePrompt, project, scene.direction?.motionClause, { motion: true }), shotActionPrompt(project, scene, options)].filter(Boolean).join('\n');

/** Build the export manifest for a project. */
export function buildHandoffManifest(project, { now = new Date().toISOString() } = {}) {
  const spec = project.visualSpec || null;
  const references = (spec?.references || []).map((ref) => ({
    id: ref.id,
    role: ref.role,
    label: ref.label,
    note: ref.note,
    condition: ref.condition === true,
    use: ref.use || 'reference',
    filename: ref.imageId,
    url: `/data/images/${encodeURIComponent(ref.imageId)}`,
  }));
  const conditioning = references.filter((ref) => ref.condition).map((ref) => ref.filename);
  return {
    format: HANDOFF_FORMAT,
    version: HANDOFF_VERSION,
    exportedAt: now,
    project: { id: project.id, name: project.name, version: project.version || 1 },
    instructions: 'Generate each scene in your external tool, keep the scene file tag (for example S03-1a2b3c4d) in every downloaded filename, then import the files on the Music Video board. PortOS never contacts the external service; attach the reference files yourself.',
    concept: { prompt: project.concept?.prompt || '', style: project.concept?.style || '', universeStyle: project.concept?.universeStyle || '', moodBoardStyle: project.concept?.moodBoardStyle || '', characterStyle: project.concept?.characterStyle || '', subjects: project.concept?.subjects || [] },
    visualSpec: {
      palette: spec?.palette || [],
      typography: spec?.typography || '',
      cameraRules: spec?.cameraRules || '',
      references,
    },
    scenes: (project.scenes || []).map((scene, index) => ({
      sceneId: scene.sceneId,
      order: index,
      fileTag: sceneFileTag(scene, index),
      label: scene.sectionLabel || scene.label || `Scene ${index + 1}`,
      startSec: scene.startSec ?? null,
      endSec: scene.endSec ?? null,
      lyricText: scene.lyricText || '',
      visualIntent: scene.visualIntent || '',
      framePrompt: sceneFramePrompt(project, scene),
      shotPrompt: sceneShotPrompt(project, scene),
      referenceFiles: conditioning,
      selected: {
        referenceImageId: scene.referenceImageId || null,
        videoHistoryId: scene.videoHistoryId || null,
      },
    })),
  };
}

/**
 * Build the downloadable ZIP counterpart of `buildHandoffManifest` (#8978):
 * the same JSON manifest (with a `missing` list appended) plus the visual
 * spec's reference images and each scene's currently-selected reference
 * frame — so the director doesn't have to save every reference out of the
 * gallery by hand before attaching it in the external tool. A reference or
 * frame this install can't resolve on disk (deleted out from under the
 * record) is reported in `missing` rather than failing the whole download.
 *
 * Returns `{ manifest, zip }` — `manifest` is the JSON actually written into
 * the archive (so a caller/test can inspect `missing` without re-parsing the
 * zip), `zip` is the archive Buffer.
 */
export async function buildHandoffBundle(project) {
  const manifest = buildHandoffManifest(project);
  const files = [];
  const missing = [];
  const seen = new Set();
  const addImage = async (filename, archivePath) => {
    if (!filename || seen.has(archivePath)) return;
    seen.add(archivePath);
    const resolved = resolveGalleryImage(filename);
    if (!resolved) { missing.push({ filename, path: archivePath }); return; }
    try {
      files.push({ name: archivePath, data: await readFile(resolved) });
    } catch {
      missing.push({ filename, path: archivePath });
    }
  };
  for (const ref of manifest.visualSpec.references) {
    await addImage(ref.filename, `references/${ref.filename}`);
  }
  for (const scene of manifest.scenes) {
    const frame = scene.selected?.referenceImageId;
    if (frame) await addImage(frame, `scenes/${scene.fileTag}-${frame}`);
  }
  const bundleManifest = { ...manifest, missing };
  const zip = createZip([
    { name: 'manifest.json', data: JSON.stringify(bundleManifest, null, 2) },
    ...files,
  ]);
  return { manifest: bundleManifest, zip };
}
