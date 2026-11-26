/**
 * Pure readings of a Blender model's state: which build to show, why a build cannot start, and the agent brief.
 *
 * No React and no requests; `state` is what `GET /api/blender-models/:id` answers.
 */
import { BLENDER_MODEL_FIXED_VIEWS as FIXED_VIEW_ANGLES } from '../../../server/lib/blenderModelCameras.js';
import { formatCount } from '../utils/formatters.js';

export const BLENDER_MODEL_SKILL_NAME = 'portos-blender-model';
export const BLENDER_MODEL_TABS = ['model', 'references', 'compare', 'files', 'builds', 'settings'];
export const BLENDER_EXECUTION_PATH = '/code-animation/production#blender-execution';

export const BLENDER_MODEL_STATUS = Object.freeze({
  draft: { label: 'Draft', className: 'text-gray-400' },
  building: { label: 'Building…', className: 'text-port-accent' },
  published: { label: 'Published', className: 'text-port-success' },
});
export const blenderModelStatusMeta = (status) => BLENDER_MODEL_STATUS[status] || BLENDER_MODEL_STATUS.draft;

/** Every kept build, newest first (the record appends as builds start). */
export const blenderModelBuilds = (state) => [...(state?.builds || [])].reverse();

/** The build on show: the requested one when it completed, else the newest completed, else null. */
export function shownBlenderModelBuild(state, requestedId = null) {
  const complete = blenderModelBuilds(state).filter((build) => build.status === 'complete');
  return complete.find((build) => build.id === requestedId) || complete[0] || null;
}

/** Why a build cannot start (`{ message, tab }`), or null when it can. */
export function blenderModelBuildBlocker(state, { unsavedFiles = [], filesSaving = false, starting = false } = {}) {
  const blocked = (message, tab) => ({ message, tab });
  if (!state) return blocked('Loading the model…', 'model');
  if (!state.tool?.ready) return blocked(state.tool?.reason || 'Blender is not ready.', 'settings');
  if (!state.workspace?.hasModel) return blocked('This model has no src/model.py yet. Create the starter, or write one.', 'files');
  if (starting || state.status === 'building') return blocked('This model is already building.', 'builds');
  if (filesSaving) return blocked('Saving a source file…', 'files');
  if (unsavedFiles.length) {
    return blocked(`Save or discard your changes to src/${unsavedFiles[0]}${unsavedFiles.length > 1 ? ` and ${formatCount(unsavedFiles.length - 1)} more` : ''} first.`, 'files');
  }
  return null;
}

/** "0.22 × 0.22 × 0.52 m", or null when a side is missing. */
export function formatMeters(size) {
  if (!size || !['x', 'y', 'z'].every((axis) => Number.isFinite(size[axis]))) return null;
  return `${['x', 'y', 'z'].map((axis) => Number(size[axis].toFixed(3))).join(' × ')} m`;
}

/** A reference image's URL and the one to try when it is not in the gallery folder. */
export const referenceImageUrls = (filename) => ['images', 'image-refs'].map((root) => `/data/${root}/${encodeURIComponent(filename)}`);

/** The brief's lines naming what the agent reads before modeling; none without references. */
function referenceLines(state) {
  const approved = (state.references || []).filter((slot) => slot.file);
  return [
    ...(state.referenceSource?.size ? [`Real size: ${state.referenceSource.size}`] : []),
    ...(approved.length ? ['Approved reference images (look at each one before modeling):', ...approved.map((slot) => (
      `  src/${slot.file}  ${slot.role === 'overall' ? 'overall sheet: six directions at one scale' : `close-up: ${slot.mechanism}`}${slot.outOfDate ? ' (out of date: made from an earlier overall sheet)' : ''}`))] : []),
    ...(state.workspace?.hasPartsBrief ? ['Parts brief: src/PARTS.md (parts, joints, axes, which view wins). Read it first and keep it true.'] : []),
  ];
}

const FIXED_VIEW_LABELS = {
  front: 'Front',
  right: 'Right (+X side)',
  back: 'Back',
  left: 'Left (-X side)',
  top: 'Top',
  bottom: 'Bottom',
  'three-quarter': 'Three-quarter',
};

/** The directions every review renders, in sheet order. */
export const BLENDER_MODEL_FIXED_VIEWS = Object.keys(FIXED_VIEW_ANGLES).map((id) => ({ id, label: FIXED_VIEW_LABELS[id] }));

/** A reference slot's name on screen. */
export const referenceLabel = (slot) => (slot.role === 'overall' ? 'Overall sheet' : slot.mechanism);

/** The filename of a reference's approved image, or null. */
export const approvedReferenceFilename = (slot) => slot?.images?.find((image) => image.id === slot.approvedImageId)?.filename ?? null;

/** What a camera choice (a fixed view id or a saved camera id) shows: its render's view id, and the saved camera if it is one. */
export function comparedCamera(state, requested) {
  const saved = (state.cameras || []).find((camera) => camera.id === requested) ?? null;
  if (saved) return { id: saved.id, camera: saved, viewId: saved.orbit ? saved.id : saved.view };
  const fixed = BLENDER_MODEL_FIXED_VIEWS.find((view) => view.id === requested) ?? BLENDER_MODEL_FIXED_VIEWS[0];
  return { id: fixed.id, camera: null, viewId: fixed.id };
}

/** A new orbit's starting distance in meters: the declared box fits a 50 mm lens. */
export const defaultOrbitDistance = (size) => (size ? Number((Math.hypot(size.x, size.y, size.z) * 1.6).toPrecision(3)) : 1);

const framing = (camera) => (camera.orbit
  ? `orbit azimuth ${camera.orbit.azimuth}, elevation ${camera.orbit.elevation}, ${camera.orbit.distance} m, ${camera.orbit.lens} mm${camera.orbit.partId ? `, aimed at ${camera.orbit.partId}` : ''}`
  : `the ${camera.view} view`);

/** The brief's second pass: where to look, and every difference still open. */
function compareLines(state) {
  const cameras = state.cameras || [];
  const open = (state.differences || []).filter((difference) => difference.status === 'open');
  const accepted = (state.differences || []).filter((difference) => difference.status === 'accepted');
  const slots = new Map((state.references || []).map((slot) => [slot.id, slot]));
  const fileOf = (referenceId) => slots.get(referenceId)?.file;
  const review = state.reviews?.[0];
  const about = (difference) => [difference.partId ? `part ${difference.partId}` : null, fileOf(difference.referenceId) ? `src/${fileOf(difference.referenceId)}` : null].filter(Boolean).join(', ');
  return [
    ...(review ? [`Review renders of build ${review.buildId}${review.outOfDate ? ' (out of date: a newer build exists)' : ''}: renders/reviews/${review.buildId}/<view>-textured.png and -clay.png, sheet-*.jpg`] : []),
    ...(cameras.length ? ['Compare cameras (reference panel -> view):', ...cameras.map((camera) => (
      `  ${camera.label}: ${fileOf(camera.referenceId) ? `src/${fileOf(camera.referenceId)}` : camera.referenceId} -> ${framing(camera)}${camera.orbit ? ` (${camera.id}-textured.png)` : ''}`))] : []),
    ...(open.length ? ['Second pass, open differences from the references. Fix each, rebuild, look at it, then close it:', ...open.map((difference) => (
      `  ${difference.id}: ${difference.text}${about(difference) ? ` (${about(difference)})` : ''}`))] : []),
    ...(accepted.length ? ['Accepted departures, leave these as they are:', ...accepted.map((difference) => `  ${difference.text}: ${difference.reason}`)] : []),
  ];
}

const findingLine = (finding) => `  ${finding.severity}: ${finding.code}${finding.subjects?.length ? ` (${finding.subjects.join(', ')})` : ''}: ${finding.message}`;

/**
 * A ready-to-paste brief for a coding agent authoring this model, from the
 * state (and the shown build's report) on screen; nothing is fetched.
 */
export function blenderModelAgentBrief(state, { report = null } = {}) {
  const base = `/api/blender-models/${state.id}`;
  const newest = blenderModelBuilds(state)[0] || null;
  const now = [
    state.workspace?.hasModel ? `src/model.py exists (${formatCount(state.workspace.files ?? 0)} source file(s)).` : 'No src/model.py yet (create the starter workspace or write one).',
    newest ? `Newest build ${newest.id}: ${newest.status}${newest.counts ? `, ${newest.counts.error} error(s), ${newest.counts.warning} warning(s)` : ''}${newest.error ? `, ${newest.error}` : ''}.` : 'Never built.',
    state.publishedBuildId ? `Published build: ${state.publishedBuildId}.` : 'Nothing is published.',
  ];
  const size = formatMeters(state.describe?.sizeMeters);
  const findings = (report?.findings || []).filter((finding) => finding.severity !== 'note');
  return [
    'You are authoring a PortOS Blender model: a reusable 3D asset built by Blender Python.',
    '',
    `Skill: ${BLENDER_MODEL_SKILL_NAME} (read it first: it holds the full contract and the build loop).`,
    `Model: ${state.name} (${state.id})`,
    ...(state.description ? [`Description: ${state.description}`] : []),
    `Workspace on this machine: ${state.workspace?.path || `data/blender-models/${state.id}`}`,
    '  src/model.py        the entry point you write (durable, backed up)',
    '  builds/<buildId>/   model.blend, model.glb, report.json, build.log: PortOS output, never edit it',
    ...referenceLines(state),
    '',
    'Contract, in src/model.py (Python inside Blender 5 or later):',
    '  describe(ctx) -> {"title", "sizeMeters": {"x","y","z"}, "triangleBudget", "parts": [{"id","label","parent"?}], "controls"?: [], "actions"?: [], "allowContact"?: []}',
    '  build(ctx) -> None   one mesh object per declared part, named by its id, parented as declared',
    '  controls (moving parts): {"id","label","type": "hinge"|"slide"|"wheel","partId","origin": [x,y,z],"axis": [x,y,z],"min","max","default","dependsOn"?: [{"control","atLeast"?,"atMost"?}]}',
    '    Degrees for hinge and wheel, meters for slide; every control runs 0-1 over min-max, and build(ctx) makes the model at the defaults. PortOS builds the bones and the control:<id> clips.',
    '  actions: {"id","label"?,"seconds"}, posed by pose(ctx, action, t) -> {controlId: 0-1}, t from 0 to 1. allowContact: [[partId, partId]] for parts meant to touch.',
    '  Meters, Z up, front facing -Y, scale applied, no negative scale. ctx: workspace, src, out_dir, quality ("draft"|"full"), log(msg).',
    '  Optional describe()["bake"] = {"size": 1024|2048|4096, "samples", "sets": [{"id","partIds"}]}: a full build bakes each set to base color, normal and packed occlusion/roughness/metal images (draft skips it). mark_bake_only(obj) from portos_model keeps detail geometry out of the GLB and into the normal map.',
    '  The script runs as trusted operator code with host access. Only run source you trust.',
    '',
    ...(size ? [`Declared now: ${size}; ${formatCount(state.describe.triangleBudget)} triangles; parts: ${(state.describe.parts || []).map((part) => part.id).join(', ') || 'none'}.`] : []),
    `Now: ${now.join(' ')}`,
    ...(findings.length ? [`Findings of build ${report.buildId}:`, ...findings.map(findingLine)] : []),
    ...compareLines(state),
    `Blender here: ${state.tool?.ready ? `ready${state.tool.version ? ` (${state.tool.version})` : ''}` : `not ready: ${state.tool?.reason || 'unknown reason'}`}.`,
    '',
    'Loop: edit src/ -> build (draft) -> read report.json and build.log -> fix errors, then warnings -> look at the review renders beside the references and record what is missing -> build again -> publish when asked.',
    '',
    `Routes (base ${base}; from a terminal session use node scripts/portos-api.js):`,
    '  GET    (base)                                the record, workspace, tool readiness and jobs',
    '  POST   /workspace                            copy the starter src/model.py when there is none',
    '  GET    /files;  GET /file?path=<p>           list src/; read one text file',
    '  PUT    /file                                 {"path","content"} write one text file;  DELETE /file?path=<p>',
    '  POST   /builds                               {"quality": "draft"|"full"} -> 202 {"job","build"}',
    '  POST   /builds/<buildId>/cancel              cancel a running build;  POST /builds/<buildId>/bakes/<setId>/cancel  cancel one set\'s bake (ends the build);  POST /builds/<buildId>/open  open its .blend in Blender',
    '  GET    /builds/<buildId>/files/<name>        model.glb, model.blend, report.json or build.log',
    '  PATCH  /reference-source                     {"size","images","ingredientId"} what the sheets start from',
    '  POST   /references                           {"mechanism"} add a close-up plate;  POST /parts-brief  create src/PARTS.md',
    '  POST   /references/<refId>/images/<imageId>/review  {"decision": "approve"|"redo", "note"?} review an image you looked at',
    '  POST   /builds/<buildId>/review             render the review again (it also runs after each build);  GET /builds/<buildId>/review/<name>  one image',
    '  POST   /cameras                              {"label","referenceId","crop"?,"view" | "orbit"};  PATCH, DELETE /cameras/<cameraId>',
    '  POST   /differences                          {"text","partId"?,"referenceId"?};  PATCH /differences/<id>  {"status": "fixed"|"accepted"|"open", "reason"?}',
    '  POST   /publish                              {"buildId"} publish a completed build without errors',
    'Every change is announced as blender-model:changed { id } over Socket.IO. Builds need Blender in Trusted local mode; never change the mode yourself.',
  ].join('\n');
}
