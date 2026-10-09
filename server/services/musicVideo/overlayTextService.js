/**
 * Music Video — the overlay text quality pass (overlayText.js says what it
 * flags and why).
 *
 * A check renders the project's composition document headless at its text
 * moments (documentRender.js `probeDocumentText`) and stores the findings on
 * `productionReview.textCheck`, bound to the document, timing, shots and takes
 * it saw (`overlayTextBasis`). The storyboard approval shows them; an
 * autonomous run checks before its final render and sends text problems back
 * to the document's author (autonomousService.js).
 *
 * No provider call: a check is local browser work, started by the director (the
 * storyboard's button), by importing or accepting a new document, or by a run
 * the director started. One check per project at a time; a newer start
 * cancels the older one, whose result is then dropped.
 */
import { randomUUID } from 'node:crypto';
import { ServerError } from '../../lib/errorHandler.js';
import { getProject, mutateProjectRecord } from './projects.js';
import { musicVideoEvents } from './events.js';
import { overlayTextBasis, productionReadiness } from './productionReview.js';
import {
  OVERLAY_TEXT_PROCESS_ID, OVERLAY_TEXT_SPAN_FRAMES, OVERLAY_TEXT_SPAN_KINDS, analyzeTextFrame, backdropStats, mergeTextRecords,
  planTextSampleTimes, sameIssue, summarizeTextFindings,
} from './overlayText.js';

const inflight = new Map(); // projectId → { id, controller, done }

const short = (id) => String(id).slice(0, 8);

function changed(project) {
  // The project-bearing notification the production review already pushes on.
  musicVideoEvents.emit('dev-artifact', { projectId: project.id, artifactId: null, project });
  return { project, readiness: productionReadiness(project) };
}

/** Refuses (409) unless the project renders a composition document with an analyzed song. */
function assertCheckable(project) {
  if (!project) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  if (project.composition?.mode !== 'document' || !project.composition.document?.directory) {
    throw new ServerError('Overlay text is checked on a composition document. Import or author one first.', { status: 409, code: 'TEXT_CHECK_UNAVAILABLE' });
  }
  if (!(project.audioAnalysis?.durationSec > 0)) {
    throw new ServerError('Analyze the song before checking overlay text.', { status: 422, code: 'NO_TIMELINE' });
  }
}

/** Render the document at its text moments and return the stored check (no write). */
async function inspectOverlayText(project, { signal, onProgress } = {}) {
  const { probeDocumentText } = await import('./documentRender.js');
  const samples = [];
  // Each extra probe, in the order it was queued: which sample's problems it traces, which way, how far.
  const steps = [];
  let plannedCount = 0;
  let clock = null;
  let textSamples = 0;
  const frameAt = (t) => Math.round(t * clock.fps);
  const lastFrame = () => Math.floor(clock.durationSec * clock.fps - 1e-6);
  // The next frame along `dir` (-1 back, +1 forward) for a sample's traced problems, or nothing past either end.
  const stepFrom = (sample, atSec, dir, step) => {
    const next = frameAt(atSec) + dir;
    if (next < 0 || next > lastFrame()) return [];
    steps.push({ sample, dir, step });
    return [next / clock.fps];
  };
  const result = await probeDocumentText({
    project, jobId: `text-check-${randomUUID()}`, signal, onProgress,
    sampleTimes: (data, docClock) => {
      clock = docClock;
      const times = planTextSampleTimes({ lyrics: data.lyrics, textCues: data.textCues, scenes: data.scenes, durationSec: docClock.durationSec, fps: docClock.fps });
      plannedCount = times.length;
      return times;
    },
    // A collision or cut-off line is traced frame by frame each way (extra probe
    // times returned to the renderer), so a momentary one reports its length.
    onSample: ({ index, atSec, frame, records, backdrop }) => {
      const items = mergeTextRecords(records);
      for (const item of items) item.backdrop = backdropStats(backdrop, item);
      const issues = analyzeTextFrame(items, frame);
      if (index < plannedCount) {
        if (items.length) textSamples += 1;
        const traced = issues.filter((i) => OVERLAY_TEXT_SPAN_KINDS.includes(i.kind));
        for (const issue of traced) issue.span = { startSec: atSec, endSec: atSec, open: false, alive: { [-1]: true, [1]: true } };
        const sample = { atSec, issues };
        samples.push(sample);
        return traced.length ? [...stepFrom(sample, atSec, -1, 1), ...stepFrom(sample, atSec, 1, 1)] : undefined;
      }
      const { sample, dir, step } = steps[index - plannedCount];
      let going = false;
      for (const issue of sample.issues) {
        if (!issue.span?.alive[dir]) continue;
        if (!issues.some((later) => sameIssue(issue, later))) { issue.span.alive[dir] = false; continue; }
        issue.span[dir < 0 ? 'startSec' : 'endSec'] = atSec;
        if (step >= OVERLAY_TEXT_SPAN_FRAMES) { issue.span.open = true; issue.span.alive[dir] = false; } else going = true;
      }
      return going ? stepFrom(sample, atSec, dir, step + 1) : undefined;
    },
  });
  for (const sample of samples) {
    for (const issue of sample.issues) {
      if (!issue.span) continue;
      const { startSec, endSec, open } = issue.span;
      // Milliseconds rounded up, so a seek to either end lands on that frame.
      const ms = (t) => Math.ceil(t * 1000 - 1e-6) / 1000;
      issue.span = { startSec: ms(startSec), endSec: ms(endSec), open, frames: frameAt(endSec) - frameAt(startSec) + 1 };
    }
  }
  return { samples: result.samples, textSamples, frame: result.frame, findings: summarizeTextFindings(samples, result.scenes) };
}

async function writeCheck(projectId, checkId, patch) {
  const { project } = await mutateProjectRecord(projectId, (current) => {
    // A newer check (or none) owns the record now: drop this one's result.
    if (current.productionReview?.textCheck?.id !== checkId) return { project: current };
    return { project: { ...current, productionReview: { ...current.productionReview,
      textCheck: { ...current.productionReview.textCheck, ...patch } } } };
  });
  return project;
}

async function runCheck(projectId, checkId, controller) {
  try {
    const project = await getProject(projectId);
    const outcome = await inspectOverlayText(project, { signal: controller.signal });
    const saved = await writeCheck(projectId, checkId, { status: 'complete', checkedAt: new Date().toISOString(), processId: null,
      samples: outcome.samples, textSamples: outcome.textSamples, frame: outcome.frame, findings: outcome.findings, error: null });
    const errors = outcome.findings.filter((f) => f.severity === 'error').length;
    console.log(`🔤 Overlay text check ${short(projectId)}: ${outcome.findings.length} finding${outcome.findings.length === 1 ? '' : 's'} (${errors} error${errors === 1 ? '' : 's'}) over ${outcome.samples} samples`);
    changed(saved);
    return saved.productionReview?.textCheck ?? null;
  } catch (err) {
    if (controller.signal.aborted) return null;
    console.error(`❌ Overlay text check ${short(projectId)} failed: ${err.message}`);
    const saved = await writeCheck(projectId, checkId, { status: 'failed', checkedAt: new Date().toISOString(), processId: null, error: String(err.message).slice(0, 500) })
      .catch(() => null);
    if (saved) changed(saved);
    return saved?.productionReview?.textCheck ?? null;
  } finally {
    if (inflight.get(projectId)?.id === checkId) inflight.delete(projectId);
  }
}

/**
 * Start a check on the project's current document (cancelling one already
 * running). Resolves `{ project, readiness, done }` once the running record is
 * written; `done` settles with the finished check (null when superseded).
 */
export async function startOverlayTextCheck(projectId) {
  assertCheckable(await getProject(projectId));
  inflight.get(projectId)?.controller.abort();
  const id = randomUUID();
  const controller = new AbortController();
  const { project } = await mutateProjectRecord(projectId, (current) => {
    assertCheckable(current);
    return { project: { ...current, productionReview: { ...current.productionReview,
      textCheck: { id, status: 'running', basis: overlayTextBasis(current), startedAt: new Date().toISOString(), processId: OVERLAY_TEXT_PROCESS_ID,
        findings: current.productionReview?.textCheck?.findings || [] } } } };
  });
  const entry = { id, controller, done: null };
  inflight.set(projectId, entry);
  entry.done = runCheck(projectId, id, controller);
  return { ...changed(project), done: entry.done };
}

/** Start a check after a new document lands; a project that cannot be checked is skipped quietly. */
export function checkOverlayTextInBackground(projectId) {
  startOverlayTextCheck(projectId).catch((err) => {
    if (!['TEXT_CHECK_UNAVAILABLE', 'NO_TIMELINE', 'NOT_FOUND'].includes(err.code)) console.error(`❌ Overlay text check ${short(projectId)} did not start: ${err.message}`);
  });
}
