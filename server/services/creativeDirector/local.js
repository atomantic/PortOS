/**
 * Creative Director — project state CRUD.
 *
 * Persists to data/creative-director-projects.json (array, atomicWrite).
 * Mirrors the shape of services/videoTimeline/local.js but stores a richer
 * model — every project has a treatment (logline + scene list) the agent
 * fills in during the planning task.
 *
 * The treatment + scene + run fields are mutated by the agent via the
 * /api/creative-director/:id/* routes. This module is the only writer to
 * the JSON file; the orchestrator and routes call into here.
 */

import { join } from 'path';
import { randomUUID } from 'crypto';
import { PATHS, readJSONFile, atomicWrite, ensureDir } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { creativeDirectorTreatmentSchema } from '../../lib/validation.js';
import { PROJECT_STATUSES } from '../../lib/creativeDirectorPresets.js';
import { createCollection } from '../mediaCollections.js';

const PROJECTS_FILE = join(PATHS.data, 'creative-director-projects.json');

async function loadAll() {
  const raw = await readJSONFile(PROJECTS_FILE, []);
  return Array.isArray(raw) ? raw : [];
}

async function saveAll(projects) {
  // Defense for first-run on a fresh checkout where data/ may not exist yet.
  // Mirrors videoTimeline/local.js#saveProjects.
  await ensureDir(PATHS.data);
  await atomicWrite(PROJECTS_FILE, projects);
}

export async function listProjects() {
  return loadAll();
}

export async function getProject(id) {
  const all = await loadAll();
  return all.find((p) => p.id === id) || null;
}

export async function createProject({ name, aspectRatio, quality, modelId, targetDurationSeconds, styleSpec = '', startingImageFile = null, userStory = null, disableAudio = true, autoAcceptScenes = false }) {
  const id = `cd-${randomUUID()}`;
  const now = new Date().toISOString();

  // Auto-create a media collection scoped to this project. All segment
  // renders + the final stitched output land in here.
  const collection = await createCollection({ name: `Creative Director: ${name}`, description: `Auto-created for project ${id}` });

  const project = {
    id,
    name,
    status: 'draft',
    createdAt: now,
    updatedAt: now,
    aspectRatio,
    quality,
    modelId,
    targetDurationSeconds,
    styleSpec,
    startingImageFile,
    userStory,
    disableAudio,
    autoAcceptScenes,
    collectionId: collection.id,
    timelineProjectId: null,
    finalVideoId: null,
    treatment: null,
    runs: [],
  };
  const all = await loadAll();
  all.push(project);
  await saveAll(all);
  console.log(`🎬 Created Creative Director project: ${id} (${name})`);
  return project;
}

export async function updateProject(id, patch) {
  const all = await loadAll();
  const idx = all.findIndex((p) => p.id === id);
  if (idx < 0) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  if (patch.status && !PROJECT_STATUSES.includes(patch.status)) {
    throw new ServerError(`Invalid status: ${patch.status}`, { status: 400, code: 'VALIDATION_ERROR' });
  }
  const updated = { ...all[idx], ...patch, updatedAt: new Date().toISOString() };
  all[idx] = updated;
  await saveAll(all);
  return updated;
}

export async function deleteProject(id) {
  const all = await loadAll();
  const next = all.filter((p) => p.id !== id);
  if (next.length === all.length) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  await saveAll(next);
  return { ok: true };
}

export async function setTreatment(id, treatmentInput) {
  const parsed = creativeDirectorTreatmentSchema.safeParse(treatmentInput);
  if (!parsed.success) {
    throw new ServerError(
      `Treatment validation failed: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`,
      { status: 400, code: 'VALIDATION_ERROR' },
    );
  }
  const all = await loadAll();
  const idx = all.findIndex((p) => p.id === id);
  if (idx < 0) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  // Initialize each scene's runtime fields if the agent didn't supply them.
  const scenes = parsed.data.scenes.map((s) => ({
    ...s,
    status: s.status || 'pending',
    retryCount: s.retryCount ?? 0,
    renderedJobId: s.renderedJobId ?? null,
    evaluation: s.evaluation ?? null,
  }));
  const nextStatus = (all[idx].status === 'paused' || all[idx].status === 'failed')
    ? all[idx].status
    : 'rendering';
  all[idx] = {
    ...all[idx],
    treatment: { logline: parsed.data.logline, synopsis: parsed.data.synopsis, scenes },
    status: nextStatus,
    updatedAt: new Date().toISOString(),
  };
  await saveAll(all);
  return all[idx];
}

export async function updateScene(id, sceneId, patch) {
  const all = await loadAll();
  const idx = all.findIndex((p) => p.id === id);
  if (idx < 0) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  const project = all[idx];
  if (!project.treatment?.scenes?.length) {
    throw new ServerError('Project has no treatment yet', { status: 400, code: 'NO_TREATMENT' });
  }
  const sceneIdx = project.treatment.scenes.findIndex((s) => s.sceneId === sceneId);
  if (sceneIdx < 0) throw new ServerError('Scene not found', { status: 404, code: 'NOT_FOUND' });
  const updated = { ...project.treatment.scenes[sceneIdx], ...patch };
  project.treatment.scenes[sceneIdx] = updated;
  project.updatedAt = new Date().toISOString();
  all[idx] = project;
  await saveAll(all);
  return updated;
}

export async function recordRun(id, runEntry) {
  const all = await loadAll();
  const idx = all.findIndex((p) => p.id === id);
  if (idx < 0) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  const project = all[idx];
  const run = { startedAt: new Date().toISOString(), ...runEntry, runId: runEntry.runId || randomUUID() };
  project.runs = [...(project.runs || []), run];
  project.updatedAt = new Date().toISOString();
  all[idx] = project;
  await saveAll(all);
  return run;
}

export async function updateRun(id, runId, patch) {
  const all = await loadAll();
  const idx = all.findIndex((p) => p.id === id);
  if (idx < 0) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  const project = all[idx];
  const runIdx = (project.runs || []).findIndex((r) => r.runId === runId);
  if (runIdx < 0) return null;
  project.runs[runIdx] = { ...project.runs[runIdx], ...patch };
  project.updatedAt = new Date().toISOString();
  all[idx] = project;
  await saveAll(all);
  return project.runs[runIdx];
}
