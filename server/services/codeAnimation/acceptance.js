/**
 * Accepted Code Animation output (#9392). Promotion is explicit and frozen to
 * the source, audio and rendered-video hashes; reading it back recomputes all
 * three from disk, so any change makes earlier passing evidence stale while the
 * accepted video stays playable. Newer failed runs never replace it.
 */
import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import { join } from 'path';
import { acceptanceFreshness, acceptanceProblem, freezeAcceptance, summarizeRunForComparison } from '../../lib/codeAnimationAcceptance.js';
import { ServerError } from '../../lib/errorHandler.js';
import { PATHS } from '../../lib/paths.js';
import { emitCodeAnimationChanged } from '../socket.js';
import { mutateVideoHistory } from '../videoGen/history.js';
import * as store from './projectStore.js';
import { getProductionProject } from './projects.js';
import { readProjectFiles, readRunArtifact, sourceHashOf } from './projectFiles.js';
import { STAGE_RUN_KIND } from './stages.js';

const RECENT_RUNS = 30;
const UNREADABLE = 'unreadable';

const hashVideo = filename => new Promise(resolve => {
  const digest = createHash('sha256');
  createReadStream(join(PATHS.videos, filename))
    .on('data', chunk => digest.update(chunk))
    .on('end', () => resolve(digest.digest('hex')))
    .on('error', () => resolve(UNREADABLE));
});

const call = async fn => { try { return await fn(); } catch { return UNREADABLE; } };

/** What the frozen record's source, audio and render hash to on disk right now. */
async function currentHashes(projectId, frozen, run) {
  const revision = await store.getRevisionRecord(projectId, frozen.revisionId);
  const artifact = run?.data.soundtrack?.artifact ?? null;
  return {
    sourceHash: revision ? await call(async () => sourceHashOf(await readProjectFiles(projectId, revision.id, revision.files))) : UNREADABLE,
    audioHash: artifact ? await call(async () => { await readRunArtifact(projectId, run.id, artifact.name, artifact.sha256); return artifact.sha256; }) : (run ? null : UNREADABLE),
    renderHash: await hashVideo(frozen.filename),
  };
}

export async function acceptProductionOutput(projectId, runId) {
  const project = await getProductionProject(projectId);
  const run = await store.getRunRecord(projectId, runId);
  if (!run || run.data.kind !== STAGE_RUN_KIND) throw new ServerError('Run not found', { status: 404, code: 'NOT_FOUND' });
  const problem = acceptanceProblem(run);
  if (problem) throw new ServerError(problem, { status: 409, code: 'CODE_ANIMATION_OUTPUT_NOT_ACCEPTABLE' });
  const renderHash = await hashVideo(run.data.output.filename);
  const measured = run.data.output.audioEvidence?.videoHash;
  if (renderHash === UNREADABLE || (measured && measured !== renderHash)) {
    throw new ServerError('The rendered video is missing or changed since the run measured it', { status: 409, code: 'CODE_ANIMATION_RENDER_CHANGED' });
  }
  const frozen = freezeAcceptance({ run, project, renderHash });
  const current = await currentHashes(projectId, frozen, run);
  const freshness = acceptanceFreshness(frozen, current);
  if (!freshness.fresh) {
    throw new ServerError(`The run's source or audio changed since it was measured: ${freshness.stale.map(item => item.reason).join(' ')}`, { status: 409, code: 'CODE_ANIMATION_EVIDENCE_STALE' });
  }
  const saved = await store.setAcceptedOutput(projectId, frozen);
  // Media History carries the accepted marker so Music Video Studio and Creative
  // Director can pick the short by its ordinary history id, with no song or episode project.
  await mutateVideoHistory(history => {
    for (const entry of history) {
      if (entry?.codeAnimation?.acceptance?.projectId === projectId && entry.id !== frozen.videoId) delete entry.codeAnimation.acceptance;
      if (entry?.id === frozen.videoId) {
        entry.codeAnimation = { ...(entry.codeAnimation || {}), revisionId: frozen.revisionId, sourceHash: frozen.sourceHash,
          acceptance: { projectId, runId, sourceHash: frozen.sourceHash, audioHash: frozen.audioHash, renderHash, acceptedAt: frozen.acceptedAt } };
      }
    }
    return history;
  });
  emitCodeAnimationChanged(projectId);
  return saved;
}

/** The accepted output with live freshness, plus recent runs summarized for side-by-side comparison. */
export async function getProductionAcceptance(projectId) {
  const project = await getProductionProject(projectId);
  const { items } = await store.pageProjectHistory(projectId, { limit: RECENT_RUNS, offset: 0 });
  const runs = items.filter(item => item.data?.kind === STAGE_RUN_KIND);
  const frozen = project.acceptedOutput ?? null;
  let accepted = null;
  if (frozen) {
    const source = runs.find(run => run.id === frozen.runId) ?? await store.getRunRecord(projectId, frozen.runId);
    accepted = { ...frozen, ...acceptanceFreshness(frozen, await currentHashes(projectId, frozen, source)) };
  }
  return { accepted, runs: runs.map(run => summarizeRunForComparison(run, frozen?.runId ?? null)) };
}

/** Accepted shorts as downstream tools consume them: a Media History id and a source package, nothing else required. */
export async function listAcceptedAssets(page) {
  const { items, nextCursor } = await store.pageAcceptedOutputs(page);
  return {
    items: items.map(({ id, title, accepted }) => ({
      projectId: id, title, videoId: accepted.videoId, filename: accepted.filename, path: accepted.path, format: accepted.format,
      sourceHash: accepted.sourceHash, audioHash: accepted.audioHash, renderHash: accepted.renderHash, acceptedAt: accepted.acceptedAt,
      packageUrl: `/api/code-animation/projects/${id}/revisions/${accepted.revisionId}/package`,
    })),
    nextCursor,
  };
}
