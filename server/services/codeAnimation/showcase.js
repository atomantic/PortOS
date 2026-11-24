/**
 * Make showcase film (issue #17880): a Code Animation film project for a
 * published Blender model, ready to edit, with no job started. It copies the
 * published GLB in as src/models/model.glb (the film-model copy of #17870), writes
 * src/showcase.json from that build's report and the model's saved cameras, copies
 * the approved overall reference sheet to src/showcase/sheet.<ext> when there is
 * one, and scaffolds the `showcase` starter (services/film/py/showcase/).
 *
 * Explicit action only; machine-local. The film is self-contained: later changes
 * to the model never touch it, and the Files tab's Update copy refreshes the GLB.
 */
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, extname } from 'node:path';
import { blenderRefusal } from '../blenderWorkspace/containment.js';
import { requireBlenderModel, getBlenderModelAsset } from '../blenderModels/models.js';
import { readBuildReport } from '../blenderModels/review.js';
import { approvedOverallSheetPath } from '../blenderModels/references.js';
import { addFilmModel } from '../film/models.js';
import { scaffoldBlenderWorkspace, writeBlenderFile } from '../film/sources.js';
import { assertInsideWithoutSymlinks, blenderWorkspaceDir, resolveBlenderSourceFile } from '../film/workspace.js';
import { codeAnimationFilmOwner, createFilmProject } from './films.js';
import { deleteProjectRecord } from './projectStore.js';

export const SHOWCASE_FPS = 24;
export const SHOWCASE_MAX_CLOSEUPS = 6;
// Natural seconds per kind of shot; mirrored by kit/plan.py DEFAULT_TIMINGS, which reads them from showcase.json.
export const SHOWCASE_TIMINGS = Object.freeze({ turn: 8, assembly: 6, control: 2.5, closeup: 3, reference: 4 });
const SHEET_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const round = (value) => Number(value.toFixed(6));

/** The showcase data (src/showcase.json) for a model record and its published build's report. Pure. */
export function buildShowcaseData(model, report, { sheet = null } = {}) {
  const described = report?.describe;
  const size = described?.sizeMeters;
  if (!size) throw blenderRefusal('The published build has no declared size to frame the film from. Build and publish the model again.', 'BLENDER_MODEL_REPORT_UNUSABLE', 409);
  const centers = report.checks?.parts?.centers ?? {};
  const motion = report.checks?.motion ?? null;
  return {
    schema: 1,
    title: model.name,
    size: { x: size.x, y: size.y, z: size.z },
    timings: { ...SHOWCASE_TIMINGS },
    parts: (described.parts ?? []).map((part) => ({ id: part.id, label: part.label ?? part.id, parent: part.parent ?? null, center: centers[part.id] ?? null })),
    controls: (motion?.controls ?? []).map((control) => ({
      id: control.id, label: control.label ?? control.id, partId: control.partId, default01: control.default01 ?? 0, dependsOn: control.dependsOn ?? [],
    })),
    actions: (motion?.actions ?? []).filter((action) => !action.error).map((action) => ({ id: action.id, label: action.label ?? action.id, seconds: action.seconds })),
    cameras: (model.cameras ?? []).slice(0, SHOWCASE_MAX_CLOSEUPS).map((camera) => ({
      id: camera.id, label: camera.label ?? camera.id, view: camera.orbit ? null : camera.view ?? null,
      orbit: camera.orbit ? { azimuth: camera.orbit.azimuth, elevation: camera.orbit.elevation, distance: camera.orbit.distance, lens: camera.orbit.lens, target: camera.orbit.target ?? null } : null,
    })),
    sheet,
  };
}

/** Length of the film at its default options: the sum of its shots' natural lengths. Mirrors kit/plan.py natural_shots. */
export function showcaseDurationSec(data) {
  const controls = data.controls.length * SHOWCASE_TIMINGS.control + data.actions.reduce((sum, action) => sum + action.seconds, 0);
  const total = SHOWCASE_TIMINGS.turn + SHOWCASE_TIMINGS.assembly + controls
    + data.cameras.length * SHOWCASE_TIMINGS.closeup + (data.sheet ? SHOWCASE_TIMINGS.reference : 0);
  return Math.max(1, round(total));
}

/** The approved sheet's file and where it lands in src/, or nulls when it is absent or not an image Blender loads. */
function sheetPlan(model) {
  const file = approvedOverallSheetPath(model);
  const extension = file ? extname(file).toLowerCase() : '';
  return SHEET_EXTENSIONS.has(extension) ? { file, path: `showcase/sheet${extension === '.jpeg' ? '.jpg' : extension}` } : { file: null, path: null };
}

async function copySheet(owner, from, path) {
  const target = (await resolveBlenderSourceFile(owner, path)).absolute;
  await mkdir(dirname(target), { recursive: true });
  await assertInsideWithoutSymlinks(blenderWorkspaceDir(owner), target);
  await copyFile(from, target);
}

/** Create the film for model `modelId`; returns the film project record. A model that is not published is a 409 before anything is made. */
export async function createShowcaseFilm(modelId, { title } = {}) {
  const model = await requireBlenderModel(modelId);
  await getBlenderModelAsset(modelId);
  const report = await readBuildReport(modelId, model.publishedBuildId);
  const sheet = sheetPlan(model);
  const data = buildShowcaseData(model, report, { sheet: sheet.path });

  const project = await createFilmProject({ title: title ?? `${model.name} showcase`, timeline: { durationSec: showcaseDurationSec(data), fps: SHOWCASE_FPS } });
  let owner;
  try {
    owner = await codeAnimationFilmOwner(project.id);
    await scaffoldBlenderWorkspace(owner, 'showcase');
    await addFilmModel(owner, { kind: 'blender-model', id: modelId, slug: 'model' });
    if (sheet.file) await copySheet(owner, sheet.file, sheet.path);
    await writeBlenderFile(owner, 'showcase.json', `${JSON.stringify(data, null, 2)}\n`);
  } catch (error) {
    await Promise.all([
      deleteProjectRecord(project.id).catch((err) => console.warn(`⚠️ Rollback failed to delete showcase film record ${project.id.slice(0, 8)}: ${err.message}`)),
      owner ? rm(owner.workspaceDir, { recursive: true, force: true }).catch((err) => console.warn(`⚠️ Rollback failed to remove showcase film workspace ${owner.workspaceLabel}: ${err.message}`)) : Promise.resolve(),
    ]);
    throw error;
  }
  console.log(`🎬 Made showcase film ${project.id.slice(0, 8)} from Blender model ${modelId.slice(0, 15)}${sheet.path ? ' with its approved sheet' : ''}`);
  return project;
}
