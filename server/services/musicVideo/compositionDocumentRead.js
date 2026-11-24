/** Read and validate immutable composition documents and shipped templates. */
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, extname, join, relative, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { pathWithin } from '../../../lib/pathWithin.js';
import { ServerError } from '../../lib/errorHandler.js';
import { PATHS } from '../../lib/fileUtils.js';
import { isPathInsideDir, isTopLevelEntryName } from '../../lib/pathSafety.js';
import { MUSIC_VIDEO_DOCUMENT_DIRECTORY, MUSIC_VIDEO_DOCUMENT_TEMPLATES } from '../../lib/musicVideo/musicVideoValidation.js';
import { imageEffectState, isEndFrameImageEffect, sceneImageEffect, scenePhotoSequence } from '../../lib/musicVideo/musicVideoImageEffects.js';
import { sceneImageEffectGlitchFrames, sceneTransitionSections, shotGlitchFrames, transitionGlitchFrames } from '../../lib/musicVideo/musicVideoTransitions.js';
import { wipeCuts } from '../../lib/musicVideo/musicVideoWipes.js';
import { documentSceneVisualLayer } from '../../lib/musicVideo/musicVideoLayers.js';
import { documentRenderClock, documentSongDuration } from './documentTiming.js';
import { assertDocumentMediaPolicy } from './documentMediaPolicy.js';
import { unsafeZipEntryName } from '../../lib/zipArchive.js';

export const DOCUMENT_MAX_BYTES = 128 * 1024 * 1024;
export const DOCUMENT_MAX_FILES = 1024;
export const DOCUMENT_ZIP_MAX_BYTES = DOCUMENT_MAX_BYTES + 16 * 1024 * 1024;
export const TEMPLATE_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'documentTemplates');
// The shared kinetic lyric-type module (#10583): lyricType.js, lyricType.css and their OFL faces.
export const SHARED_ROOT = join(TEMPLATE_ROOT, 'shared');
export const LYRIC_TYPE_REF = /\blyricType\.(?:js|css)\b/;
export const LYRIC_TYPE_SCAN_MAX = 2 * 1024 * 1024;
const MIME_TYPES = Object.freeze({
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.txt': 'text/plain', '.md': 'text/plain', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
});

/** The served media type for a document file (octet-stream when unknown). */
export const documentMimeType = (path) => MIME_TYPES[extname(String(path)).toLowerCase()] || 'application/octet-stream';

export const refuse = (message, code = 'COMPOSITION_DOCUMENT_INVALID', status = 422) => new ServerError(message, { status, code });

export const documentsRoot = () => join(PATHS.data, 'music-video');
/**
 * Absolute folder for a stored document pointer, or null when the pointer is
 * not a version folder inside data/music-video/ (a hand-edited or peer record).
 */
export function resolveDocumentDirectory(document) {
  const directory = document?.directory;
  if (typeof directory !== 'string' || !MUSIC_VIDEO_DOCUMENT_DIRECTORY.test(directory)) return null;
  const abs = resolve(PATHS.data, directory);
  return isPathInsideDir(documentsRoot(), abs) ? abs : null;
}

/** Whether the project has a document pointer whose folder holds an index.html on this install. */
export async function documentAvailable(project) {
  const dir = resolveDocumentDirectory(project?.composition?.document);
  if (!dir) return false;
  const info = await lstat(join(dir, 'index.html')).catch(() => null);
  return Boolean(info?.isFile());
}

/**
 * Every regular file under `root` as `[{ rel, abs, size }]`, refusing symlinks,
 * special files and a tree over the file / byte caps. `rel` uses `/`.
 */
export async function collectTree(root, { excludeTests = false } = {}) {
  const files = [];
  let bytes = 0;
  async function walk(dir, prefix) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = `${prefix}${entry.name}`;
      const abs = join(dir, entry.name);
      // lstat, not the dirent alone: a symlink is refused even when it points inside.
      const info = await lstat(abs);
      if (info.isSymbolicLink()) throw refuse(`Composition documents cannot contain symlinks (${rel})`, 'COMPOSITION_DOCUMENT_SYMLINK');
      if (info.isDirectory()) { await walk(abs, `${rel}/`); continue; }
      if (!info.isFile()) throw refuse(`Composition documents can only contain regular files (${rel})`);
      if (unsafeZipEntryName(rel)) throw refuse(`Unsupported file name in the composition document (${rel})`);
      if (excludeTests && rel.endsWith('.test.js')) continue;
      files.push({ rel, abs, size: info.size });
      bytes += info.size;
      if (files.length > DOCUMENT_MAX_FILES || bytes > DOCUMENT_MAX_BYTES) {
        throw refuse(`A composition document is limited to ${DOCUMENT_MAX_FILES} files and ${DOCUMENT_MAX_BYTES / (1024 * 1024)} MiB`, 'COMPOSITION_DOCUMENT_TOO_LARGE', 413);
      }
    }
  }
  await walk(root, '');
  return { files, bytes };
}

/**
 * A document that references the shared lyric-type module (lyricType.js / .css)
 * without shipping it gets PortOS's copy and its faces added at its root, so an
 * uploaded document never renders without its type. Files the document ships
 * itself (its own lyricType.js, its own fonts) are kept as they are.
 */
export async function withSharedLyricType(files) {
  const rels = new Set(files.map((file) => file.rel));
  let referenced = false;
  for (const file of files) {
    if (!/\.(?:html?|m?js|css)$/i.test(file.rel) || (file.size ?? file.data?.length ?? 0) > LYRIC_TYPE_SCAN_MAX) continue;
    const text = file.data ? file.data.toString('utf8') : await readFile(file.abs, 'utf8');
    if (LYRIC_TYPE_REF.test(text)) { referenced = true; break; }
  }
  if (!referenced) return files;
  const { files: shared } = await collectTree(SHARED_ROOT, { excludeTests: true });
  const missing = shared.filter((file) => file.rel !== 'toonWorld.js' && !rels.has(file.rel));
  return missing.length ? [...files, ...missing] : files;
}

// Ship the actual browser-safe effect definition, preserving an authored copy.
export async function withSharedImageEffects(files) {
  if (files.some(file => file.rel === 'musicVideoImageEffects.js')) return files;
  for (const file of files) {
    if (!/\.(?:html?|m?js)$/i.test(file.rel) || (file.size ?? file.data?.length ?? 0) > LYRIC_TYPE_SCAN_MAX) continue;
    const text = file.data ? file.data.toString('utf8') : await readFile(file.abs, 'utf8');
    if (!/\bmusicVideoImageEffects\.js\b/.test(text)) continue;
    const abs = fileURLToPath(new URL('../../lib/musicVideo/musicVideoImageEffects.js', import.meta.url));
    return [...files, { rel: 'musicVideoImageEffects.js', abs, size: (await stat(abs)).size }];
  }
  return files;
}

const SHIPPED_CAMERA_RIG = new URL('../../lib/musicVideo/cameraRig.js', import.meta.url);

// Known compatible shipped layered engines. Recognition only;
// customized engines belong to the author and are never silently replaced.
const UPGRADABLE_LAYERED_ENGINES = new Set([
  // Shipped before the layered engine waited for deferred modules.
  'cbf7bb8abf01b262f2f18964d80fda9285c3cd735f2847379975d5301b493253',
  // Shipped before template additions preserved planned still-camera moves.
  '8d811b406d1c7440df7ab83dea4ed83ced5b797ca2ae73c5d3c6d861230a1e34',
  // Shipped before the handheld camera template additions.
  'a20bb2cf128153aada5c963baf8af22ca4a5ca72bda56d801b2d41a693cb606e',
  // Shipped before card painters honored beat-reaction controls (#15629).
  '4ee3ae7c78bce6d9dde36a1f2336c7bfd899918f359b6a9906b619c07a0bfb1b',
  // Shipped before per-video and per-shot template controls (#15622).
  'b45ad91d8def477e02761e4a2b61c4546b68a3e53cf5f4038fcaa30c9596bac8',
  // The shipped engine before shot color match (#15596).
  '106e8a140d76e7fa33734d24ec5ea90f57e8f5a21ba873e505edc49e80eb550e',
  // The shipped engine before cut wipes (#14831).
  'b5180a986424a2d6c15cde037baa72088ebf347e79e21b0e89f3c957936d1062',
  // The shipped engine before document end-frame and selected glitch effects.
  '0cc9d52c4bbf82cec93b418e41e7cfe49a89f6feb0602c02ecdee6f00f9cf307',
  // Shipped between still effects (#11319) and the later lyric-runtime check.
  '22d6cf739b607da221780f32524baeb70ae86ddf9f0a83d57b9a5462dd93b44a',
  'ecf110208a0861eb35a39ca559997eca647b922b49c1ca5d5bddc35b2f37bd61',
  '20fff73949a37d069f1de4cf2dab4d185049f799fe4bb129747cc3bf678d9e4f',
  // #14276's engine: one photo at a time, before overlapping photo stacks (#14277).
  '934ee8ca6b42f642bec05019c208e54369d063f06b521384d20d54b0b8e0900a',
  '2844a20f3d6ad57022e97ae79705a9296479ff5a59cdebeaa9e48246d3d7a086',
  // Last shipped engine before document still-image effects (#11319).
  '9581bb2d190e62ea2eb6a709bc989b1f913c501236554cd0301379877dc8a5fc',
  'dc27611ebaa429c28bd467b003495d2a1c7dc0ede73be0cfc28db4b97c964dcf',
  '2556a0905a85958b9107cfa75ab0c5bfde167a708e29b511d577065bb530ea58',
  'e2267a068c92a3c7dee49db5f3e57caff1ac11aee1312c0d82e28352850aad3b',
  '23842766a818fd9820d79ff229eab538cc0edf391992756cbfd14434d525c019',
  '5f69f39cfbdbf0531c23250d01773447529a5254271b0b77f40d029d02bb0e1f',
  // #10583's engine (shared lyricType.js), before cameraRig.js (#10589); an upgraded
  // copy without the rig script keeps a slow push.
  '02ca75c17c58eec1bb37463fdd187a133d8c10499bb2b6556c793af8d63b93e8',
]);
// Shipped still-effect modules a document may carry; adoption replaces them with the current one.
export const UPGRADABLE_IMAGE_EFFECT_MODULES = new Set([
  // #15571: still-effect module before honoring Use end frame (`endFrameOff`).
  // Commit 16f8de61cd (module-private photo layout normalizer).
  'bf072f2842ff71aa5b95da0a42c47b861b7d7e8d3c1759524907538ccc8f157a',
  // #11319's initial still-effect module.
  '4f13c0c26039cdecd0dab5450ebe702d49653e207594af07297ced8f21c2eb1e',
  'b771bf1da99500e14b751ffe82a95ddee749df2030d1a8be7c21b068a7def1e8',
  // #14276: photo sequences, before stacked layers (#14277).
  '6289528435cb4b9cd535679a6492a6ecd22258213fc5361db13ae301dfda3cde',
]);
// This shipped module already supplies the new engine's imports and also
// exposes an extra export. Keep its bytes for documents that may use it.
export const COMPATIBLE_IMAGE_EFFECT_MODULES = new Set([
  'b5905e6d5be37d5d8b1ed0a1c741e3f9813b65c70eec182a3a3cf86efd4ec92d',
  // #16084 moved the module's catalog row into its header comment; code unchanged.
  'fdd1e93223f14339dab56e95a79844b5926f799b1070ab8df38419332e447993',
]);
// Earlier shipped copies of the helper files a stock document carries beside its engine.
// A copy with one of these digests is a stale shipped file, not an authored one, and an
// engine update replaces it so the document still matches the shipped template.
const STALE_SHIPPED_LYRIC_TYPE_JS = new Set([
  'c82298cb8f071974cf417339522748051d034303721ddbe12e5167c93a24df7f',
  '92b3a82171a90d5bf66842584bdb95e6e24f726b77b04de196c7376123f93822',
  'c6c45a4919987a7ff90fb22715b16957dc7035f6b445648131200f8ca130e286',
  '35dfe8c1e5a9be5f240cab306857fa48115dcedcf33b0f81d5e6c726be930cf5',
  '1aa9ff1d6c02e50d9c7bef1fefb3afb610f7c2018a2e59305c9aadac40862cfa',
  '837cb2839c93ae8bc5d0372918790b32d3afaae7fbee4cec0a657af1d3e9d49a',
  'd5689550f2f30acef76c807b6fc04e0cd4000adf93b75ea219a3de922233dc02',
  'ff366d59be6489808a82ea72bf7a85e02ae7d1865762347ff51c3cc7b85544b8',
  'ee8e37c9d0c23268949b2c7ff2c0647d20aeeeacc698835ce874440b4a6acb10',
  'cd77d73d5d6f5a0ac5359014f4cf460b6b81c52a85f033c671de2a44e953ed80',
  '2cc217941dde3c1013917ba7c8e787d7b89ac1361bc5171df81746960f007524',
  'f2f2cc5094a6407226b5f5d62c6788ccc7220a8e13ad6b81415422d3efa3f961',
  '2a9fc1fd8d983a54b50f373d47d6b83fa1b984a189922ba3e5f401f16dd2c9e2',
  '40c3f48c6eebfc8dff62c48c0a0bf70269efaf81a97e004e79acf72bc96fd414',
]);
const STALE_SHIPPED_CAMERA_RIG = new Set([
  // Shipped before Object.hasOwn replaced hasOwnProperty.call (#17890); same behavior.
  '508b9bbad6490903f53c0928fb24a62812caf17800ded5c7248bf7b7740b95a2',
]);
export const engineDigest = bytes => createHash('sha256').update(bytes.toString('utf8').replace(/\r\n?/g, '\n')).digest('hex');

// The helper files documentPreviewPlayback compares byte for byte, with where the shipped copy lives.
// The still-effect module only ever grew its exports, so every earlier shipped copy is replaceable.
export const STOCK_HELPERS = [
  { rel: 'cameraRig.js', source: SHIPPED_CAMERA_RIG, stale: STALE_SHIPPED_CAMERA_RIG },
  { rel: 'lyricType.js', source: new URL('./documentTemplates/shared/lyricType.js', import.meta.url), stale: STALE_SHIPPED_LYRIC_TYPE_JS },
  { rel: 'lyricType.css', source: new URL('./documentTemplates/shared/lyricType.css', import.meta.url), stale: new Set() },
  { rel: 'musicVideoImageEffects.js', source: new URL('../../lib/musicVideo/musicVideoImageEffects.js', import.meta.url),
    stale: new Set([...UPGRADABLE_IMAGE_EFFECT_MODULES, ...COMPATIBLE_IMAGE_EFFECT_MODULES]) },
];

/** Whether `bytes` is an earlier shipped copy of the helper `rel`, which an engine update replaces. */
export const isStaleShippedHelper = (rel, bytes) => STOCK_HELPERS.find(helper => helper.rel === rel)?.stale.has(engineDigest(bytes)) === true;

/** Whether `engine` (engine.js bytes) is an older shipped layered engine that "Update layered engine" can replace. */
export const isUpgradableLayeredEngine = engine => UPGRADABLE_LAYERED_ENGINES.has(engineDigest(engine));

/**
 * A shipped template's directory (documentTemplates/<id>). The callers allow
 * only `MUSIC_VIDEO_DOCUMENT_TEMPLATES` first; an id that climbs out throws
 * here all the same (`pathWithin`), which is what lets the test memo key the
 * templates directory for a read whose id it cannot see.
 */
export const documentTemplateDirectory = (templateId) => pathWithin(TEMPLATE_ROOT, templateId);

export async function collectTemplateFiles(templateId) {
  if (!MUSIC_VIDEO_DOCUMENT_TEMPLATES.includes(templateId)) throw refuse('Unknown composition template', 'VALIDATION_ERROR', 400);
  const { files } = await collectTree(documentTemplateDirectory(templateId), { excludeTests: true });
  if (templateId === 'layered') {
    // Export and browser preview use the same classic script as the native client.
    files.push({ rel: 'cameraRig.js', abs: fileURLToPath(SHIPPED_CAMERA_RIG), size: (await stat(SHIPPED_CAMERA_RIG)).size });
  }
  return files;
}

/**
 * A shipped template's files as `readDocumentFiles` returns them, read in place
 * with the shared lyric-type module beside them, for a preview no project owns
 * (the lyric timing playthrough). Nothing is copied into the project.
 */
export async function readTemplateDocumentFiles(templateId = 'layered') {
  const files = await collectTemplateFiles(templateId);
  return new Map((await withSharedImageEffects(await withSharedLyricType(files))).map((file) => [file.rel, { abs: file.abs, size: file.size }]));
}

/**
 * The storyboard animatic's lyric overlay page (documentTemplates/lyricOverlay),
 * read like `readTemplateDocumentFiles`: the words alone on a transparent frame.
 * It is not a template a project can pick.
 */
export async function readLyricOverlayDocumentFiles() {
  const { files } = await collectTree(join(TEMPLATE_ROOT, 'lyricOverlay'), { excludeTests: true });
  return new Map((await withSharedImageEffects(await withSharedLyricType(files))).map((file) => [file.rel, { abs: file.abs, size: file.size }]));
}

export async function requireDocument(project) {
  const dir = resolveDocumentDirectory(project?.composition?.document);
  if (!dir || !(await documentAvailable(project))) {
    throw refuse('This project has no composition document on this machine — import one or start from the template', 'COMPOSITION_DOCUMENT_MISSING', 409);
  }
  return dir;
}

/**
 * The absolute folder of the project's composition document when it is in
 * `document` mode and present on this install, else null. documentRender.js
 * builds the native-playback verdict on it (it sits above this module).
 */
export async function availableDocumentDirectory(project) {
  if (project?.composition?.mode !== 'document' || !(await documentAvailable(project))) return null;
  return resolveDocumentDirectory(project.composition.document);
}

/** The document folder a render stages; throws COMPOSITION_DOCUMENT_MISSING. */
export async function documentDirectoryForRender(project, { requireSelectedEffects = true } = {}) {
  await readDocumentFiles(project, { requireSelectedEffects });
  const dir = await requireDocument(project);
  return relative(PATHS.data, dir).split(sep).join('/');
}

const SELECTED_EFFECT_LABELS = { transition: 'glitch transitions', glitch: 'in-shot glitches', end: 'end-frame effects', wipe: 'wipes' };
// The `portos-selected-effects` level a document must declare to draw each kind: 2 adds wipes (#14831).
const SELECTED_EFFECT_LEVELS = { transition: 1, glitch: 1, end: 1, wipe: 2 };

const selectedEffectKinds = shots => Object.keys(SELECTED_EFFECT_LABELS)
  .filter(kind => shots.some(shot => shot.effects.includes(kind))).map(kind => SELECTED_EFFECT_LABELS[kind]);

// The highest `portos-selected-effects: N` an engine.js or index.html declares, 0 when none.
const declaredEffectsLevel = async files => {
  const declarations = files.filter(file => ['engine.js', 'index.html'].includes(file.rel));
  const levels = await Promise.all(declarations.map(async file =>
    Number(/^(?:\/\/ portos-selected-effects: (\d+)|<!-- portos-selected-effects: (\d+) -->)$/m.exec(await readFile(file.abs, 'utf8'))?.slice(1).find(Boolean) || 0)));
  return Math.max(0, ...levels);
};

// The shots with effects a document at `level` cannot draw, each naming only those effects.
const unsupportedAt = (shots, level) => shots
  .map(shot => ({ ...shot, effects: shot.effects.filter(kind => SELECTED_EFFECT_LEVELS[kind] > level) }))
  .filter(shot => shot.effects.length);

/**
 * The shots whose selected effects land inside the song and need an engine that
 * declares `portos-selected-effects`: `[{ sceneId, effects: ['transition'|'glitch'|'end'|'wipe'] }]`.
 * Each shot is checked with only its own effects so the list names the shots.
 */
function selectedEffectShots(project) {
  const scenes = project.scenes || [];
  const duration = documentSongDuration(project);
  const { fps, frames } = documentRenderClock(duration || 0);
  const sections = sceneTransitionSections(scenes, fps, { endSec: duration, cameras: project.cameras });
  const inSong = effect => effect.frame >= 0 && effect.frame < frames;
  const found = new Map();
  const add = (sceneId, kind) => {
    if (!found.has(sceneId)) found.set(sceneId, []);
    if (!found.get(sceneId).includes(kind)) found.get(sceneId).push(kind);
  };
  const bare = ({ transitionIn: _in, transitionOut: _out, wipeIn: _wipeIn, wipeOut: _wipeOut, ...section }) => section;
  for (const section of sections) {
    if ((section.transitionIn || section.transitionOut)
      && transitionGlitchFrames(sections.map(other => other === section ? other : bare(other)), { totalFrames: frames }).length > 0) add(section.sceneId, 'transition');
    if ((section.wipeIn || section.wipeOut) && wipeCuts(sections.map(other => other === section ? other : bare(other)), { fps }).length > 0) add(section.sceneId, 'wipe');
    if (section.shotGlitches && shotGlitchFrames([section], fps).some(inSong)) add(section.sceneId, 'glitch');
  }
  const generated = project.composition?.document?.source?.kind === 'generated';
  const imageExists = id => isTopLevelEntryName(id) && !id.includes('..') && existsSync(join(PATHS.images, id));
  const eligibleEnd = scenes.filter(scene => Number.isFinite(scene?.startSec) && scene?.visualLayer === 'still' && isEndFrameImageEffect(scene.imageEffect)
    && scene.endFrameOff !== true && scene.endImageId && documentSceneVisualLayer(project, scene, { generated }) === 'still').filter(scene => {
    const sequence = scenePhotoSequence(scene);
    return imageExists(scene.endImageId) && (sequence ? sequence.imageIds.length > 0 && sequence.imageIds.every(imageExists) : imageExists(scene.referenceImageId));
  });
  // The layered engine displays only valid intervals, using the latest valid
  // scene at an overlap. Its glitch overlay has a separate frame timeline.
  const layeredScenes = scenes.filter(scene => scene?.sceneId && Number.isFinite(scene.startSec)
    && Number.isFinite(scene.endSec) && scene.endSec > scene.startSec).sort((a, b) => a.startSec - b.startSec);
  for (const scene of eligibleEnd) {
    const index = layeredScenes.indexOf(scene);
    const next = layeredScenes[index + 1];
    const lastFrame = index < 0 ? -1 : Math.min(frames, Math.ceil(scene.endSec * fps), next ? Math.ceil(next.startSec * fps) : frames) - 1;
    const visible = index >= 0 && lastFrame >= Math.max(0, Math.ceil(scene.startSec * fps)) && (() => {
      const state = imageEffectState(sceneImageEffect(scene, { layered: true }), (lastFrame - Math.round(scene.startSec * fps)) / fps, { fps });
      return state.end > 0 || state.flash > 0;
    })();
    if (visible || sceneImageEffectGlitchFrames(scenes.map(other => other === scene ? other : { ...other, imageEffect: null }),
      fps, { layered: true, endSec: duration, cameras: project.cameras }).some(inSong)) add(scene.sceneId, 'end');
  }
  return [...found].map(([sceneId, effects]) => ({ sceneId, effects }));
}

/**
 * Shots whose selected effects this document cannot draw (its engine predates
 * them): `[{ sceneId, effects }]`, empty when every effect is drawn. The live
 * preview plays without them and names them; renders refuse instead.
 */
export async function unsupportedDocumentEffects(project) {
  const { files } = await collectTree(await requireDocument(project));
  return unsupportedAt(selectedEffectShots(project), await declaredEffectsLevel(files));
}

/** Every file a document ships, read into memory (the preview builder). */
export async function readDocumentFiles(project, { requireLyricVisibility = true, requireSelectedEffects = true } = {}) {
  const dir = await requireDocument(project);
  const { files } = await collectTree(dir);
  await assertDocumentMediaPolicy(project, files);
  if (requireSelectedEffects) {
    const shots = unsupportedAt(selectedEffectShots(project), await declaredEffectsLevel(files));
    if (shots.length) throw new ServerError(`This composition does not declare support for the selected shot effects (${selectedEffectKinds(shots).join(', ')}). Update the layered engine under Document source, or add effect support to the custom document.`, {
      status: 422, code: 'DOCUMENT_SELECTED_EFFECTS_UNSUPPORTED',
    });
  }
  const sequences = (project.scenes || []).map(scene => scenePhotoSequence(scene)).filter(Boolean);
  if (sequences.length) {
    const engine = files.find(file => file.rel === 'engine.js');
    // Engine marker 1 plays one photo at a time; 2 also composes overlapping, laid-out photos (#14277).
    const level = engine ? Number(/^\/\/ portos-photo-sequence: (\d+)$/m.exec(await readFile(engine.abs, 'utf8'))?.[1] || 0) : 0;
    const needed = sequences.some(sequence => sequence.stacked) ? 2 : 1;
    if (level < needed) throw new ServerError(needed > 1
      ? 'Update the composition playback engine to support overlapping photo layers before previewing or rendering.'
      : 'Update the composition playback engine to support photo sequences before previewing or rendering.', {
      status: 422, code: 'DOCUMENT_PHOTO_SEQUENCE_UNSUPPORTED',
    });
  }
  // Immutable documents retain their own runtime. Refuse an unsupported lyric
  // pass instead of claiming this project preference changed its output.
  if (requireLyricVisibility && project.lyricOverlayEnabled === false) {
    const runtimes = files.filter((file) => ['lyricType.js', 'engine.js'].includes(file.rel));
    const marked = await Promise.all(runtimes.map(async (file) =>
      /^\/\/ portos-lyric-overlay-visibility: 1$/m.test(await readFile(file.abs, 'utf8'))));
    if (!marked.length || !marked.every(Boolean)) {
      throw new ServerError('Update the document lyric renderer to support automatic lyric overlays being disabled before rendering. Authored text remains independent.', {
        status: 422, code: 'DOCUMENT_LYRIC_VISIBILITY_UNSUPPORTED',
      });
    }
  }
  const out = new Map();
  for (const file of files) out.set(file.rel, { abs: file.abs, size: file.size });
  return out;
}
