/**
 * The whole state of a project's Blender film, as `GET /:id/blender` and every
 * mutating answer return it: settings, tool readiness, the workspace, the
 * synced manifest, each shot's renders, cuts, jobs and notes. Reads the
 * project record, the workspace and in-memory jobs; starts no film job. The
 * tool section repeats the Code Animation execution report, whose first read
 * after a restart may re-run an unchanged configuration's own check.
 */
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { blenderShotFrameRange, normalizeBlenderRecord } from '../../lib/musicVideoBlender.js';
import { blenderMediaPath, blenderRendersDir, blenderSrcDir, blenderWorkspaceDir, blenderWorkspaceLabel, readBlenderJson } from './workspace.js';
import { hashBlenderSources } from './hashing.js';
import { blenderFilmProblems, readBlenderManifest } from './manifest.js';
import { readBlenderRenders } from './renderIndex.js';
import { listBlenderJobs } from './jobs.js';

export const BLENDER_NEEDS_TRUSTED_LOCAL = 'A Blender film renders on the GPU and writes into the project workspace, so it needs Blender in Trusted local mode. Switch the execution mode under Blender execution (Code Animation > Production, or this panel\'s Settings) and run the execution check.';

export const blenderCutsFile = (owner) => join(blenderRendersDir(owner), 'cuts', 'cuts.json');

/** `{ ready, reason, executionMode, engine, version }` from the execution lane's last check. */
async function blenderToolState() {
  const { getCodeAnimationExecution } = await import('../codeAnimation/execution.js');
  const execution = await getCodeAnimationExecution();
  const trusted = execution.executionMode === 'trusted-local';
  const lane = execution.lanes.blender;
  return {
    ready: trusted && lane.ready === true,
    reason: trusted ? lane.reason || null : BLENDER_NEEDS_TRUSTED_LOCAL,
    executionMode: execution.executionMode,
    engine: execution.tools.blender.engine,
    version: execution.probe?.tools?.blender?.version || null,
  };
}

function manifestState(manifest, { settings, sceneMap }, timeline, sources) {
  if (!manifest) return null;
  return {
    title: manifest.title || '',
    syncedAt: manifest.syncedAt || null,
    // The frame rate the shots were snapped to: renders wait for a sync when the setting moves off it.
    fps: manifest.fps ?? null,
    // What the film lets the operator set; the saved values are `settings.options`.
    options: manifest.options,
    shots: manifest.shots.map((shot) => ({
      id: shot.id, label: shot.label, start: shot.start, end: shot.end,
      ...(shot.handles ? { handles: shot.handles } : {}),
      set: shot.set || '', summary: shot.summary || '', action: shot.action || '', staging: shot.staging || '',
      camera: shot.camera || '', transition: shot.transition || '',
      frames: blenderShotFrameRange(shot, settings.fps).frameCount,
      sceneId: sceneMap[shot.id] || null,
    })),
    problems: blenderFilmProblems(manifest, {
      fps: settings.fps, durationSec: timeline.durationSec,
      cutEffects: timeline.cutEffects?.(manifest) || [],
    }),
    srcChanged: manifest.srcHash !== sources.tree,
  };
}

async function cutsState(owner, renders) {
  const listed = await readBlenderJson(blenderCutsFile(owner), []);
  const cuts = [];
  for (const cut of Array.isArray(listed) ? listed : []) {
    if (typeof cut?.file !== 'string' || !/^(preview|final)-[0-9A-Za-z-]+\.mp4$/.test(cut.file)) continue;
    const absolute = join(blenderRendersDir(owner), 'cuts', cut.file);
    if (!(await lstat(absolute).catch(() => null))?.isFile()) continue;
    cuts.push({
      id: cut.id, quality: cut.quality, file: blenderMediaPath(owner, absolute), createdAt: cut.createdAt,
      durationSec: cut.durationSec, missing: cut.missing || [], stale: cut.stale || [], filmLook: cut.filmLook === true,
      // `missing` and `stale` are what the cut was made from. A shot rendered since is not in
      // this cut at all: the cut shows its older picture (or black), however current it was then.
      rerendered: Object.entries(renders).filter(([, render]) => render[cut.quality]?.complete && String(render[cut.quality].finishedAt) > String(cut.createdAt))
        .map(([shotId]) => shotId),
    });
  }
  return cuts.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/** The state of `project`'s Blender film. */
async function buildBlenderState(owner) {
  const record = normalizeBlenderRecord(await owner.readRecord());
  const [sources, tool, manifest] = await Promise.all([hashBlenderSources(owner), blenderToolState(), readBlenderManifest(owner)]);
  const exists = (await lstat(blenderWorkspaceDir(owner)).catch(() => null))?.isDirectory() === true;
  // The stored shots (with their `deps`) decide staleness, not the presented ones.
  const renders = manifest ? await readBlenderRenders(owner, manifest, { settings: record.settings, sources }) : {};
  return {
    settings: record.settings,
    tool,
    workspace: {
      exists,
      dir: blenderWorkspaceLabel(owner),
      // Where this machine keeps it, for the operator and a coding agent to open.
      path: blenderWorkspaceDir(owner),
      hasFilm: (await lstat(join(blenderSrcDir(owner), 'film.py')).catch(() => null))?.isFile() === true,
      files: sources.files.size,
    },
    manifest: manifestState(manifest, record, await owner.timeline(), sources),
    renders,
    // Whether the project's final video is behind these renders (null: no final joined from this film).
    finalStale: null,
    cuts: await cutsState(owner, renders),
    jobs: listBlenderJobs(owner),
    notes: record.notes,
  };
}

export async function getBlenderState(owner) {
  return buildBlenderState(owner);
}
