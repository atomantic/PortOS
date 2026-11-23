/**
 * Pure readings of a Blender model's state: which build to show, why a build cannot start, and the agent brief.
 *
 * No React and no requests; `state` is what `GET /api/blender-models/:id` answers.
 */
import { formatCount } from '../utils/formatters.js';

export const BLENDER_MODEL_SKILL_NAME = 'portos-blender-model';
export const BLENDER_MODEL_TABS = ['model', 'files', 'builds', 'settings'];
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
    '',
    'Contract, in src/model.py (Python inside Blender 5 or later):',
    '  describe(ctx) -> {"title", "sizeMeters": {"x","y","z"}, "triangleBudget", "parts": [{"id","label","parent"?}], "controls"?: []}',
    '  build(ctx) -> None   one mesh object per declared part, named by its id, parented as declared',
    '  Meters, Z up, front facing -Y, scale applied, no negative scale. ctx: workspace, src, out_dir, quality ("draft"|"full"), log(msg).',
    '  The script runs as trusted operator code with host access. Only run source you trust.',
    '',
    ...(size ? [`Declared now: ${size}; ${formatCount(state.describe.triangleBudget)} triangles; parts: ${(state.describe.parts || []).map((part) => part.id).join(', ') || 'none'}.`] : []),
    `Now: ${now.join(' ')}`,
    ...(findings.length ? [`Findings of build ${report.buildId}:`, ...findings.map(findingLine)] : []),
    `Blender here: ${state.tool?.ready ? `ready${state.tool.version ? ` (${state.tool.version})` : ''}` : `not ready: ${state.tool?.reason || 'unknown reason'}`}.`,
    '',
    'Loop: edit src/ -> build (draft) -> read report.json and build.log -> fix errors, then warnings -> build again -> publish when asked.',
    '',
    `Routes (base ${base}; from a terminal session use node scripts/portos-api.js):`,
    '  GET    (base)                                the record, workspace, tool readiness and jobs',
    '  POST   /workspace                            copy the starter src/model.py when there is none',
    '  GET    /files;  GET /file?path=<p>           list src/; read one text file',
    '  PUT    /file                                 {"path","content"} write one text file;  DELETE /file?path=<p>',
    '  POST   /builds                               {"quality": "draft"|"full"} -> 202 {"job","build"}',
    '  POST   /builds/<buildId>/cancel              cancel a running build;  POST /builds/<buildId>/open  open its .blend in Blender',
    '  GET    /builds/<buildId>/files/<name>        model.glb, model.blend, report.json or build.log',
    '  POST   /publish                              {"buildId"} publish a completed build without errors',
    'Every change is announced as blender-model:changed { id } over Socket.IO. Builds need Blender in Trusted local mode; never change the mode yourself.',
  ].join('\n');
}
