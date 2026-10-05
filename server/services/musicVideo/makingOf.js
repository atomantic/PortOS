/** Read-only, deterministic making-of packages. No network, persistence or publication. */
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { PATHS } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { createZip } from '../../lib/zipWriter.js';
import { escapeRegExp } from '../../lib/textUtils.js';
import { getProject } from './projects.js';
import { productionReadiness, productionAlignmentBasis } from './productionReview.js';
import { extractMakingOfVisuals, reencodeMakingOfRaster, MAKING_OF_VISUAL_LIMITS } from './makingOfVisuals.js';

const SEGMENT = /^[A-Za-z0-9_-]{1,100}$/;
const validSegment = value => typeof value === 'string' && SEGMENT.test(value);
const TYPES = new Set(['.png', '.jpg', '.jpeg', '.webp', '.md', '.html', '.htm']);
const MAX_FILE = 20 * 1024 * 1024;
const MAX_PACKAGE = 100 * 1024 * 1024;
const MAX_ITEMS = 300;
const rasterExtension = filename => {
  const ext = extname(String(filename || '')).toLowerCase();
  return ['.png', '.jpg', '.jpeg', '.webp'].includes(ext) ? ext : '.png';
};
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const hash = value => createHash('sha256').update(value).digest('hex');
const conflict = () => { throw new ServerError('Planning or assets changed. Preview the inventory again.', { status: 409, code: 'MAKING_OF_CHANGED' }); };
const badSelection = () => { throw new ServerError('Invalid making-of selection', { status: 400, code: 'VALIDATION_ERROR' }); };

// Export a bounded projection, never raw records, provider configuration or logs.
// Remove URLs (including private server links), absolute paths and recognizable
// credentials even when pasted into an otherwise legitimate creative field.
function scrubText(value, limit) {
  if (typeof value !== 'string') return '';
  if (value.length >= 256 && /^[A-Za-z0-9+/]+={0,2}$/.test(value)) return '[binary omitted]';
  return value.slice(0, limit)
    .replace(/(?:(?:https?:)?\/\/|file:\/\/|data:)[^\s<>"')]+/gi, '[link omitted]')
    .replace(/(^|[\s('"=:])(?:[A-Z]:[\\/]|~[\\/]|\/)[^\s<>"')]+/gi, '$1[path omitted]')
    .replace(/\\\\[^\s<>"')]+/g, '[path omitted]')
    .replace(/\b[A-Za-z0-9.-]+\.ts\.net\b/gi, '[private host omitted]')
    .replace(/\b(?:Bearer\s+\S+|(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/gi, '[credential omitted]')
    .replace(/\b(?:api[_ -]?key|password|secret|token|authorization|cookie)\s*[:=]\s*[^\s,;]+/gi, '[credential omitted]');
}
const text = value => scrubText(value, 16000);
const markdown = value => text(value).replace(/!?\[[^\]]*\]\([^)]*\)/g, '[link omitted]').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const linkLabel = value => markdown(value).replace(/[\[\]\\]/g, character => escapeRegExp(character));
const jsonBlock = value => json(value).split('\n').map(line => `    ${line}`).join('\n');
const fields = (obj, keys) => Object.fromEntries(keys.map(k => [k, text(obj?.[k])]));
const time = value => Number.isFinite(value) && value >= 0 ? value : null;

// Original planning imports can carry richer contracts than the editable draft.
// Preserve that structure, with explicit privacy redaction rather than projecting
// it down to the four fields the current importer understands.
function portable(value, depth = 0) {
  if (depth > 25) return '[depth limit]';
  if (typeof value === 'string') return scrubText(value, MAX_FILE);
  if (Array.isArray(value)) return value.map(item => portable(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key, item]) => !/(?:password|secret|token|credential|authorization|cookie|api[_-]?key|private[_-]?key|absolute[_-]?path|server[_-]?url|logs|base64|referenceBytes|imageData|binaryData|embeddedAssets)/i.test(key)
      && !(/^(?:bytes|data|blob|buffer|binary)$/i.test(key) && (Array.isArray(item) || typeof item === 'string')))
    .map(([key, item]) => [text(key), portable(item, depth + 1)]));
  return value;
}

function planning(project) {
  const draft = project.productionReview?.draft || {};
  const direction = project.castAndSets?.direction;
  const scenes = project.scenes || [];
  const sourceShots = draft.storyboard?.length ? draft.storyboard : scenes;
  const shots = sourceShots.map((shot, index) => {
    const scene = scenes.find(s => s.sceneId === shot.sceneId) || shot;
    return {
      id: text(shot.id || shot.sceneId) || `unbound-${index + 1}`,
      identityStatus: shot.id || shot.sceneId ? 'recorded' : 'missing',
      sceneId: text(shot.sceneId) || null,
      order: index,
      startSec: time(shot.startSec), endSec: time(shot.endSec),
      timingStatus: draft.timingStatus || 'provisional',
      ...fields(scene, ['label', 'sectionLabel', 'lyricText', 'visualIntent', 'framePrompt', 'prompt', 'medium']),
      ...fields(shot, ['action', 'staging', 'camera', 'transition']),
      lyricCueIds: (shot.lyricCueIds || []).map(text),
    };
  });
  return {
    project: { id: project.id, name: text(project.name), version: project.version || 1, mediaMode: text(project.mediaMode), updatedAt: text(project.updatedAt),
      parentProjectId: text(project.parentProjectId) || null, rootProjectId: text(project.rootProjectId) || project.id },
    master: { durationSec: time(project.audioAnalysis?.durationSec), alignmentBasis: productionAlignmentBasis(project),
      contentHash: text(project.audioAnalysis?.audioHash) || null, contentHashStatus: project.audioAnalysis?.audioHash ? 'recorded' : 'not-recorded' },
    lyricCues: (project.lyricCues || []).map(cue => ({ id: text(cue.id), text: text(cue.text), startSec: time(cue.startSec), endSec: time(cue.endSec), words: portable(cue.words || []) })),
    originalScenes: scenes.map(scene => ({ sceneId: text(scene.sceneId), startSec: time(scene.startSec), endSec: time(scene.endSec),
      ...fields(scene, ['label', 'sectionLabel', 'visualIntent', 'framePrompt', 'prompt', 'medium']), action: portable(scene.action), direction: portable(scene.direction), visualLayer: portable(scene.visualLayer) })),
    readiness: portable(productionReadiness(project)),
    approvals: Object.fromEntries(Object.entries(project.productionReview?.approvals || {}).map(([stage, approval]) => [stage, fields(approval, ['basis', 'approvedAt'])])),
    concept: fields(project.concept, ['prompt', 'style']),
    castAndSets: direction ? portable(direction) : null,
    review: { ...fields(draft, ['cast', 'environments', 'visualLanguage', 'motionLanguage', 'implementationPlan', 'timingNotes']), storyboardSource: text(draft.storyboardSource) || 'board' },
    settings: {
      compositionMode: text(project.composition?.mode), authoringRenderer: text(project.composition?.authoringRenderer),
      aspectRatio: text(project.aspectRatio), strategy: text(project.productionPolicy?.strategy),
      palette: (project.visualSpec?.palette || []).map(text), ...fields(project.visualSpec, ['cameraRules', 'typography']),
      castSetsRoute: fields(project.castAndSets?.route, ['mode', 'model']),
    },
    shots,
  };
}

function candidates(project) {
  const items = [];
  for (const artifact of project.devArtifacts || []) {
    if (artifact.deleted || !validSegment(artifact.id)) continue;
    for (const version of artifact.versions || []) {
      if (!Number.isInteger(version.version) || version.version < 1) continue;
      const ext = extname(String(version.file || '')).toLowerCase();
      const safeExt = /^\.[a-z0-9]{1,5}$/.test(ext) ? ext : '.unsupported';
      const expected = `music-video/${project.id}/dev/${artifact.id}/v${version.version}${ext}`;
      items.push({ id: `artifact:${artifact.id}:v${version.version}`, kind: text(artifact.kind), label: `${text(artifact.title)} · v${version.version}`,
        version: version.version, source: text(version.source), reviewStatus: version.version === artifact.version ? text(artifact.status) : 'historical-unverified',
        relative: expected, ext,
        recordedFile: version.file,
        sharedArtifact: version.file !== expected,
        ownershipRequired: !['generated', 'planning-import'].includes(version.source),
        sourceAssetId: artifact.id,
        path: `projects/${project.id}/artifacts/${artifact.id}/v${version.version}${version.source === 'planning-import' ? '.json' : ['.html', '.htm'].includes(ext) ? '.md' : safeExt}` });
    }
  }
  for (const [key, item] of Object.entries(project.castAndSets?.plan || {})) {
    if (!/^[A-Za-z0-9_:-]{1,100}$/.test(key)) continue;
    const image = project.castAndSets?.images?.[key];
    const filename = image?.imageId;
    items.push({ id: `cast:${key}`, kind: 'cast-sets', label: text(item.label) || key,
      source: 'generated', jobId: image?.jobId, filename, tag: { castKey: key },
      sourceAssetId: /^[A-Za-z0-9_-]+\.(png|jpg|jpeg|webp)$/i.test(filename) ? filename : null,
      ext: extname(String(filename || '')).toLowerCase(), path: `projects/${project.id}/images/cast-${key.replace(/:/g, '_')}-${hash(key).slice(0, 8)}${rasterExtension(filename)}`,
      prompt: text(image?.submittedPrompt || item.prompt), generationStatus: text(image?.status), revision: image?.submittedRevision ?? null,
    });
  }
  for (const scene of project.scenes || []) {
    if (!validSegment(scene.sceneId)) continue;
    const take = (scene.takes || []).find(t => t.kind === 'image' && t.assetId === scene.referenceImageId);
    items.push({ id: `frame:${scene.sceneId}`, kind: 'storyboard', label: text(scene.label || scene.sectionLabel) || scene.sceneId,
      source: text(take?.source), jobId: take?.jobId, filename: scene.referenceImageId, tag: { sceneId: scene.sceneId },
      sourceAssetId: /^[A-Za-z0-9_-]+\.(png|jpg|jpeg|webp)$/i.test(scene.referenceImageId) ? scene.referenceImageId : null,
      ext: extname(String(scene.referenceImageId || '')).toLowerCase(), path: `projects/${project.id}/images/frame-${scene.sceneId}${rasterExtension(scene.referenceImageId)}`,
      prompt: text(take?.prompt || scene.framePrompt),
    });
  }
  for (const reference of project.visualSpec?.references || []) {
    const id = validSegment(reference.id) ? reference.id : hash(String(reference.imageId || reference.label || '')).slice(0, 16);
    items.push({ id: `reference:${id}`, kind: 'reference', label: text(reference.label) || 'Visual reference', source: 'reference',
      sourceAssetId: text(reference.id) || null, filename: reference.imageId,
      path: `projects/${project.id}/images/reference-${id}${rasterExtension(reference.imageId)}`, ext: extname(String(reference.imageId || '')).toLowerCase() });
  }
  if (items.length > MAX_ITEMS) throw new ServerError('Too many export candidates', { status: 413, code: 'MAKING_OF_LIMIT' });
  return items.sort((a, b) => a.id.localeCompare(b.id, 'en'));
}

async function loadProject(id) {
  if (!validSegment(id)) badSelection();
  const project = await getProject(id);
  if (!project || project.id !== id || project.deleted) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  return project;
}

// Reject every symlink component and open the leaf with O_NOFOLLOW. Read through
// the checked handle with a bounded buffer, never follow arbitrary record paths.
async function readOwned(relative) {
  const segments = relative.split('/');
  if (segments.some(s => !/^[A-Za-z0-9_.-]+$/.test(s) || s === '.' || s === '..')) return { status: 'excluded', reason: 'unsafe-path' };
  let abs = PATHS.data;
  let handle;
  try {
    for (const segment of ['', ...segments]) {
      abs = segment ? join(abs, segment) : abs;
      if ((await lstat(abs)).isSymbolicLink()) return { status: 'excluded', reason: 'symlink' };
    }
    handle = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile()) return { status: 'excluded', reason: 'not-file' };
    if (stat.nlink !== 1) return { status: 'excluded', reason: 'shared-file-link' };
    if (stat.size > MAX_FILE) return { status: 'excluded', reason: 'size-limit' };
    const data = Buffer.alloc(stat.size + 1);
    let bytesRead = 0;
    while (bytesRead < data.length) {
      const read = await handle.read(data, bytesRead, data.length - bytesRead, bytesRead);
      if (!read.bytesRead) break;
      bytesRead += read.bytesRead;
    }
    const after = await handle.stat();
    if (bytesRead !== stat.size || stat.mtimeMs !== after.mtimeMs || stat.size !== after.size) return { status: 'excluded', reason: 'changed-during-read' };
    return { status: 'included', data: data.subarray(0, bytesRead) };
  } catch (err) {
    return { status: err.code === 'ENOENT' ? 'missing' : 'excluded', reason: err.code === 'ENOENT' ? 'file-missing' : 'unreadable' };
  } finally { await handle?.close(); }
}

function declaredOwnership(pick) { return pick?.ownershipConfirmed === true && pick.rights === 'owned'; }

async function galleryGeneration(filename, owners) {
  const { getJob } = await import('../mediaJobQueue/index.js');
  for (const owner of owners) {
    const images = Object.entries(owner.castAndSets?.images || {}).filter(([, image]) => image.imageId === filename)
      .map(([key, image]) => ({ jobId: image.jobId, key }));
    for (const scene of owner.scenes || []) {
      for (const take of scene.takes || []) {
        if (take.kind === 'image' && take.source === 'generated' && take.assetId === filename) images.push({ jobId: take.jobId, sceneId: scene.sceneId });
      }
    }
    for (const image of images) {
      const job = image.jobId ? getJob(image.jobId) : null;
      const tag = job?.params?.musicVideo;
      if (job?.kind === 'image' && tag?.projectId === owner.id && job.result?.filename === filename
        && (image.key ? tag?.castAndSets?.key === image.key : tag?.sceneId === image.sceneId)) return { job, projectId: owner.id };
    }
  }
  return null;
}

async function readCandidate(project, item, pick = null, owners = [project], { catalog = false } = {}) {
  if (!item.relative && !item.filename) return { status: 'missing', reason: 'not-generated' };
  if (!TYPES.has(item.ext)) return { status: 'excluded', reason: 'unsupported-type' };
  let generationSettings = null;
  let sourceProjectId = project.id;
  let relative = item.relative;
  let ownership = 'project-generated';
  if (item.relative) {
    let source = item.source;
    if (item.sharedArtifact) {
      const found = owners.flatMap(owner => (owner.devArtifacts || []).filter(artifact => !artifact.deleted && artifact.id === item.sourceAssetId)
        .flatMap(artifact => (artifact.versions || []).filter(version => version.version === item.version
          && version.file === item.recordedFile && version.file === `music-video/${owner.id}/dev/${artifact.id}/v${version.version}${item.ext}`)
          .map(version => ({ owner, version })))).find(Boolean);
      if (!found) return { status: catalog ? 'requires-owner-project' : 'excluded', reason: 'owner-project-not-selected' };
      relative = found.version.file; source = found.version.source; sourceProjectId = found.owner.id;
    }
    if (!['generated', 'planning-import'].includes(source)) {
      if (!declaredOwnership(pick)) return { status: catalog ? 'requires-ownership' : 'excluded', reason: 'ownership-unverified' };
      ownership = 'operator-declared';
    }
  }
  if (!item.relative) {
    if (!/^[A-Za-z0-9_-]+\.(png|jpg|jpeg|webp)$/i.test(item.filename)) return { status: 'excluded', reason: 'unsafe-path' };
    // Membership is necessary but not sufficient. Shared generated assets may
    // be verified against another explicitly selected owning project. An owned
    // declaration admits imported user-owned bytes, but never grants arbitrary paths.
    const proof = await galleryGeneration(item.filename, owners);
    if (!proof && !declaredOwnership(pick)) return { status: catalog ? 'requires-ownership' : 'excluded', reason: 'ownership-unverified' };
    if (proof) {
      sourceProjectId = proof.projectId;
      generationSettings = Object.fromEntries(['mode', 'model', 'modelId', 'negativePrompt', 'negative_prompt', 'seed', 'width', 'height', 'steps', 'cfg', 'scheduler']
        .filter(key => proof.job.params[key] != null).map(key => [key, portable(proof.job.params[key])]));
    } else ownership = 'operator-declared';
  }
  const read = await readOwned(relative || `images/${item.filename}`);
  if (!read.data) return read;
  if (['.html', '.htm', '.md'].includes(item.ext)) {
    if (item.source === 'planning-import') {
      const pre = read.data.toString('utf8').match(/<pre\b[^>]*>([\s\S]*?)<\/pre>/i)?.[1];
      const decoded = pre?.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      let parsed;
      try { parsed = JSON.parse(decoded); } catch { return { status: 'excluded', reason: 'invalid-source-planning' }; }
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return { status: 'excluded', reason: 'invalid-source-planning' };
      return { status: 'included', data: Buffer.from(json(portable(parsed))), sourceProjectId, ownership,
        transformation: 'original planning JSON with privacy redactions; approvals remain unverified' };
    }
    if (['.html', '.htm'].includes(item.ext)) {
      const sheet = await extractMakingOfVisuals(read.data.toString('utf8'), { path: item.path, parentId: item.id,
        allowRaster: declaredOwnership(pick), scrub: value => scrubText(value, MAX_FILE) });
      return { ...sheet, generationSettings, sourceProjectId, ownership };
    }
    const clean = scrubText(read.data.toString('utf8').replace(/<[^>]*>/g, '\n'), MAX_FILE)
      .replace(/!?\[[^\]]*\]\([^)]*\)/g, '[link omitted]').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    read.data = Buffer.from(`${clean}\n`);
    read.transformation = 'Markdown text with unverified links omitted';
  } else {
    // Re-encode raster bytes to strip EXIF, private paths, embedded metadata and
    // polyglot payloads. No SVG/HTML may masquerade as a selected image.
    const format = item.ext === '.png' ? 'png' : item.ext === '.webp' ? 'webp' : 'jpeg';
    const output = await reencodeMakingOfRaster(read.data, format);
    if (!output || output.length > MAX_FILE) return { status: 'excluded', reason: 'invalid-or-oversize-image' };
    read.data = output;
    read.transformation = 'raster re-encoded without metadata';
  }
  return { ...read, generationSettings, sourceProjectId, ownership };
}

function snapshot(project) { return hash(json({ planning: planning(project), candidates: candidates(project) })); }
export async function getMakingOfCatalog(projectId) {
  const project = await loadProject(projectId);
  const assets = [];
  for (const item of candidates(project)) {
    const read = await readCandidate(project, item, null, [project], { catalog: true });
    assets.push({ id: item.id, label: item.label, kind: item.kind, version: item.version ?? null, source: item.source,
      status: read.status, reason: read.reason || null, bytes: (read.data?.length ?? 0) + (read.visuals || []).reduce((sum, visual) => sum + (visual.data?.length || 0), 0), path: item.path,
      visualCount: read.visuals?.length || 0, ownershipDeclarationAvailable: ['.html', '.htm'].includes(item.ext) || read.status === 'requires-ownership' });
  }
  return { project: planning(project).project, snapshot: snapshot(project), assets };
}

const csvCell = value => `"${String(value ?? '').replace(/^\s*[=+@-]/, "'$&").replace(/"/g, '""')}"`;
const csv = shots => {
  const keys = ['id', 'sceneId', 'order', 'startSec', 'endSec', 'timingStatus', 'label', 'lyricText', 'visualIntent', 'action', 'staging', 'camera', 'transition', 'medium'];
  return `${keys.join(',')}\n${shots.map(shot => keys.map(key => csvCell(shot[key])).join(',')).join('\n')}\n`;
};

export async function compileMakingOf(selection, { download = false } = {}) {
  const files = [];
  let total = 0;
  const add = (name, data) => {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    total += buffer.length;
    if (total > MAX_PACKAGE) throw new ServerError('Making-of package exceeds 100 MiB', { status: 413, code: 'MAKING_OF_LIMIT' });
    files.push({ name, data: buffer });
  };
  const inventory = [];
  const projects = [];
  const owners = await Promise.all(selection.projects.map(selected => loadProject(selected.projectId)));
  for (const selected of [...selection.projects].sort((a, b) => a.projectId.localeCompare(b.projectId, 'en'))) {
    const project = owners.find(owner => owner.id === selected.projectId);
    if (snapshot(project) !== selected.snapshot) conflict();
    const plan = planning(project);
    projects.push(plan.project);
    const root = `projects/${project.id}`;
    const items = candidates(project);
    const chosen = new Map(selected.assets.map(asset => [asset.id, asset]));
    if ([...chosen.keys()].some(id => !items.some(item => item.id === id))) badSelection();
    const imageLinks = { 'cast-sets': [], storyboard: [] };
    const artifactLinks = { 'cast-sets': [], storyboard: [] };
    for (const item of items) {
      const pick = chosen.get(item.id);
      const checked = await readCandidate(project, item, pick, owners);
      const read = pick ? checked : { status: checked.data ? 'not-selected' : checked.status, reason: checked.reason || null };
      const entry = { projectId: project.id, id: item.id, kind: item.kind, label: item.label, version: item.version ?? null,
        path: item.path, selected: !!pick, status: read.status, reason: read.reason || null, bytes: read.data?.length ?? 0,
        sha256: read.data ? hash(read.data) : null,
        rights: pick?.rights || 'unknown', attribution: text(pick?.attribution),
        delivery: read.data ? 'file' : item.kind === 'reference' ? 'metadata-only' : 'unavailable-or-unselected',
        provenance: { source: item.source, sourceAssetId: item.sourceAssetId || null, reviewStatus: item.reviewStatus || null,
          prompt: item.prompt || '', revision: item.revision ?? null, generationSettings: read.generationSettings || null,
          sourceProjectId: read.sourceProjectId || null, ownership: read.ownership || 'unverified' },
        transformation: read.transformation || null };
      inventory.push(entry);
      if (read.data) {
        add(item.path, read.data);
        if (artifactLinks[item.kind] && /\.md$/.test(item.path)) artifactLinks[item.kind].push(`[${item.id}](${item.path.slice(root.length + 1)})`);
        for (const visual of read.visuals || []) {
          inventory.push({ projectId: project.id, id: visual.id, label: visual.label, kind: item.kind, status: visual.status, reason: visual.reason,
            path: visual.path, bytes: visual.data?.length || 0, sha256: visual.data ? hash(visual.data) : null,
            rights: pick.rights || 'unknown', attribution: text(pick.attribution), delivery: visual.data ? 'file' : 'unavailable',
            provenance: { source: 'embedded-sheet-graphic', sourceArtifactId: item.sourceAssetId, sourceVersion: item.version,
              sourceSha256: visual.sourceSha256, sourceProjectId: read.sourceProjectId,
              ownership: declaredOwnership(pick) ? 'operator-declared' : read.ownership } });
          if (visual.data) {
            add(visual.path, visual.data);
            if (imageLinks[item.kind]) imageLinks[item.kind].push(`![${visual.id}](${visual.path.slice(root.length + 1)})`);
          }
        }
        if (item.source === 'planning-import') {
          const original = JSON.parse(read.data.toString());
          for (const sourceAsset of Array.isArray(original.assets) ? original.assets : []) {
            const sourceId = text(sourceAsset?.id) || hash(json(sourceAsset)).slice(0, 16);
            inventory.push({ projectId: project.id, id: `source:${item.id}:${sourceId}`, kind: 'source-reference',
              label: text(sourceAsset?.label) || sourceId, sourceAssetId: sourceId, path: null,
              status: 'excluded', reason: 'source-planning-metadata-only', delivery: 'metadata-only', rights: 'unknown', attribution: '' });
          }
          if (Array.isArray(original.storyboard) && original.storyboard.length) {
            const keys = [...new Set(original.storyboard.flatMap(shot => Object.keys(shot || {})))].sort();
            const base = item.path.replace(/\.json$/, '-storyboard');
            add(`${base}.csv`, `${keys.map(csvCell).join(',')}\n${original.storyboard.map(shot => keys.map(key => csvCell(typeof shot?.[key] === 'object' ? JSON.stringify(shot[key]) : shot?.[key])).join(',')).join('\n')}\n`);
            add(`${base}.md`, `# Original planning storyboard — unverified\n\n${original.storyboard.map(shot => jsonBlock(shot)).join('\n\n')}`);
          }
        }
        if (imageLinks[item.kind] && /\.(png|jpe?g|webp)$/.test(item.path)) imageLinks[item.kind].push(`![${item.id}](${item.path.slice(root.length + 1)})`);
      }
    }
    for (const kind of ['cast-sets', 'storyboard']) {
      if (!items.some(item => item.kind === kind)) inventory.push({ projectId: project.id, id: `missing:${kind}`, kind,
        status: 'missing', reason: 'no-artifact-or-image', path: null, rights: 'unknown', attribution: '' });
    }
    if (!plan.castAndSets && !plan.review.cast && !plan.review.environments) inventory.push({ projectId: project.id, id: 'missing:cast-planning', status: 'missing', reason: 'no-cast-set-planning', path: null });
    if (!plan.shots.length) inventory.push({ projectId: project.id, id: 'missing:shots', status: 'missing', reason: 'no-shot-planning', path: null });
    add(`${root}/planning.json`, json(plan));
    add(`${root}/shots.json`, json(plan.shots));
    add(`${root}/shots.csv`, csv(plan.shots));
    add(`${root}/cast-set-sheet.md`, `# ${markdown(plan.project.name)} — Cast & Sets\n\nSelected visual sheets: ${artifactLinks['cast-sets'].join(', ') || 'none'}\n\n${plan.castAndSets ? jsonBlock(plan.castAndSets) : 'Cast & Sets direction missing.'}\n\n${markdown(plan.review.cast)}\n\n${markdown(plan.review.environments)}\n\n${imageLinks['cast-sets'].join('\n\n')}\n`);
    add(`${root}/storyboard.md`, `# ${markdown(plan.project.name)} — Storyboard\n\nSelected visual sheets: ${artifactLinks.storyboard.join(', ') || 'none'}\n\nTiming: ${markdown(project.productionReview?.draft?.timingStatus) || 'provisional'}\n\n${plan.shots.length ? plan.shots.map(shot => `## ${markdown(shot.id)}: ${shot.startSec ?? '?'}–${shot.endSec ?? '?'} seconds\n\n${markdown(shot.visualIntent)}\n\nAction: ${markdown(shot.action)}\n\nStaging: ${markdown(shot.staging)}\n\nCamera: ${markdown(shot.camera)}\n\nTransition: ${markdown(shot.transition)}\n`).join('\n') : 'Shot planning missing.'}\n\n${imageLinks.storyboard.join('\n\n')}\n`);
  }
  const unresolved = inventory.filter(item => item.status !== 'included' || item.rights === 'unknown' || (item.rights === 'licensed' && !item.attribution));
  add('README.md', `# Music Video Making-of\n\nLocal planning export from PortOS. No repository has been created or published.\n\n${projects.map(project => `- [${linkLabel(project.name)}](projects/${project.id}/storyboard.md) — ${project.mediaMode || 'unspecified medium'}, version ${project.version}`).join('\n')}\n\nEach project contains cast/set and storyboard sheets, shot JSON/CSV, and planning.json with prompts and selected settings. manifest.json records every selected, missing, excluded and unselected candidate, provenance, rights and transformations. Paths are relative; no PortOS server is required.\n\n${unresolved.length} inventory entries need review. Missing files and unresolved rights remain unresolved; export is not proof of completion or publication clearance. Licensed assets require attribution. Review all content before sharing. Unselected or unverified reference bytes, logs, credentials, audio/video and executable composition files are excluded. Selected HTML sheets become Markdown with ordered relative PNG graphics and captions. Validated static SVG geometry is rasterized without executing HTML; embedded raster graphics require an explicit owned declaration. Raster output is re-encoded without metadata. Unsafe or unavailable graphics remain visible omissions. Sheet content is portable; the original HTML layout is not reproduced pixel for pixel. Shared assets require a selected, verified owner or an explicit ownership declaration where offered.\n\nSHA256SUMS covers every package file except itself. No license is inferred. Future GitHub publication requires explicit content, owner, repository name and visibility approval.\n`);
  const manifest = { format: 'portos-music-video-making-of', version: 1, projects, inventory,
    publication: 'not-published', rightsStatus: 'requires-review', limits: { fileBytes: MAX_FILE, packageBytes: MAX_PACKAGE, visuals: MAKING_OF_VISUAL_LIMITS },
    files: files.map(file => ({ path: file.name, bytes: file.data.length, sha256: hash(file.data) })).sort((a, b) => a.path.localeCompare(b.path, 'en')) };
  add('manifest.json', json(manifest));
  files.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  add('SHA256SUMS', files.map(file => `${hash(file.data)}  ${file.name}\n`).join(''));
  files.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  const digest = hash(json(files.map(file => [file.name, hash(file.data)])));
  if (download && (!selection.previewDigest || digest !== selection.previewDigest)) conflict();
  return { manifest, previewDigest: digest, bytes: total,
    files: files.map(file => ({ path: file.name, bytes: file.data.length, sha256: hash(file.data) })),
    ...(download ? { zip: createZip(files) } : {}) };
}
