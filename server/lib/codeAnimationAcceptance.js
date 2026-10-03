/**
 * Code Animation production acceptance (#9392). Pure: it separates the
 * measured evidence of a finished run into technical, visual, temporal and
 * sound dimensions, decides whether a run may be promoted, and detects when an
 * accepted output no longer matches the source, audio and render it was frozen
 * against. A dimension nothing measured is `unverified` and never a pass.
 */

export const ACCEPTANCE_DIMENSIONS = ['technical', 'visual', 'temporal', 'sound'];

const CHECK_DIMENSION = {
  'frame-size': 'technical', 'blank-frame': 'technical', 'renderer-runtime': 'technical', 'baked-scene': 'technical',
  'visual-motion': 'visual', 'semantic-visual': 'visual',
  timing: 'temporal', 'stepped-transform-cadence': 'temporal', 'continuous-camera': 'temporal', 'audio-event-placement': 'temporal',
  audio: 'sound', 'audio-stream': 'sound', 'audio-duration': 'sound',
};
const FINDING_DIMENSION = {
  'duration-mismatch': 'temporal', 'frame-rate-mismatch': 'temporal', 'frozen-film': 'temporal', 'frozen-span': 'temporal', 'event-without-change': 'temporal',
  'visual-review': 'visual',
};

export const dimensionOfCheck = name => CHECK_DIMENSION[name] || (/audio|sound|hear/.test(name) ? 'sound' : 'technical');
export const dimensionOfFinding = kind => FINDING_DIMENSION[kind] || 'technical';

// Nothing in the pipeline listens to the film; these stay unverified until a reviewer says otherwise.
const ALWAYS_UNVERIFIED = [
  { dimension: 'hearing', reason: 'No listening review ran; how the sound feels against the picture is not measured.' },
  { dimension: 'temporal-sync', reason: 'Pacing and sound sync beyond the declared events are not measured.' },
];

/** `{ technical, visual, temporal, sound }`, each `{ status, verified, unverified, findings }`. */
function acceptanceEvidence({ findings = [], verified = [], unverified = [] }) {
  const result = Object.fromEntries(ACCEPTANCE_DIMENSIONS.map(key => [key, { status: 'unverified', verified: [], unverified: [], findings: [] }]));
  for (const check of verified) result[dimensionOfCheck(check)].verified.push(check);
  for (const item of [...unverified, ...ALWAYS_UNVERIFIED]) {
    result[item.dimension === 'temporal-sync' ? 'temporal' : dimensionOfCheck(item.dimension)].unverified.push({ dimension: item.dimension, reason: item.reason });
  }
  for (const finding of findings) result[dimensionOfFinding(finding.kind)].findings.push(finding);
  for (const entry of Object.values(result)) {
    entry.status = entry.findings.some(finding => finding.severity === 'error') ? 'failed'
      : !entry.verified.length ? 'unverified' : entry.unverified.length ? 'partial' : 'verified';
  }
  return result;
}

/** Why a finished run cannot be promoted to the accepted output, or null when it can. */
export function acceptanceProblem(run) {
  const data = run?.data;
  if (!data || data.kind !== 'production-stages') return 'That is not a production run.';
  if (run.status !== 'completed' || !data.output?.videoId) return 'Only a completed run with a final video can be accepted.';
  if (data.verdict?.status !== 'pass') return `The run's evidence did not pass (${data.verdict?.status || 'none'}).`;
  if (data.verdict.revisionId !== data.output.revisionId || data.verdict.sourceHash !== data.output.sourceHash) {
    return 'The final video was rendered from a different source than the evidence measured.';
  }
  if (!/^[A-Za-z0-9._-]+\.mp4$/.test(data.output.filename || '')) return 'The final video has no managed file.';
  return null;
}

/** The immutable record promotion stores. `renderHash` is measured by the caller from the file on disk. */
export function freezeAcceptance({ run, project, renderHash, now = new Date().toISOString() }) {
  const { data } = run;
  const { output } = data;
  return {
    version: 1, runId: run.id, stageRunId: output.stageRunId ?? null, revisionId: output.revisionId,
    sourceHash: output.sourceHash, packageHash: output.packageHash, audioHash: output.audioHash ?? null, renderHash,
    videoId: output.videoId, filename: output.filename, path: output.path, jobId: output.jobId ?? null,
    title: project.title, format: project.manifest.format, acceptedAt: now,
    evidence: acceptanceEvidence({ findings: data.findings, verified: output.verifiedDimensions, unverified: output.unverified }),
  };
}

/** Compare a frozen acceptance with what is on disk now. Any unreadable or different hash is stale. */
export function acceptanceFreshness(frozen, current) {
  const stale = [];
  const compare = (dimension, label) => {
    if (current[`${dimension}Hash`] !== frozen[`${dimension}Hash`]) {
      stale.push({ dimension, reason: current[`${dimension}Hash`] === 'unreadable' ? `The ${label} could not be read back.` : `The ${label} changed after it was accepted.` });
    }
  };
  compare('source', 'source files');
  compare('audio', 'soundtrack');
  compare('render', 'rendered video');
  return { fresh: stale.length === 0, stale };
}

/** One run as the comparison view needs it: settings, budgets, spend and evidence side by side. */
export function summarizeRunForComparison(run, acceptedRunId = null) {
  const { data } = run;
  const inspect = [...(data.stages || [])].reverse().find(stage => stage.key === 'inspect' && stage.status === 'completed');
  const frames = (data.stages || []).filter(stage => stage.key === 'style-frame')
    .flatMap(stage => (stage.artifacts || []).map(artifact => ({ revisionId: stage.revisionId, atSeconds: artifact.atSeconds, path: `/data/${artifact.relativePath}` })));
  const pilots = (data.stages || []).filter(stage => stage.key === 'pilot' && stage.status === 'completed')
    .map(stage => ({ revisionId: stage.revisionId, video: stage.sequence?.artifact ? `/data/${stage.sequence.artifact.relativePath}` : null, samples: stage.samples?.length ?? 0 }));
  const reviewer = [...(data.stages || [])].reverse().find(stage => stage.key === 'review' && stage.reviewer)?.reviewer ?? null;
  return {
    runId: run.id, status: run.status, createdAt: run.createdAt, accepted: run.id === acceptedRunId,
    revisionId: data.currentRevisionId, sourceRevisionId: data.sourceRevisionId,
    // Model effort is the authoring route's reasoning budget; it is not GPU samples or a repair count.
    settings: { requested: data.requested ?? null, effective: data.effective ?? null, renderer: data.renderer ?? null },
    budgets: data.budgets ?? null,
    spend: { repairs: data.spent?.iterations ?? 0, tokens: data.spent?.tokens ?? 0, renderMs: data.spent?.renderMs ?? 0, elapsedMs: data.spent?.elapsedMs ?? 0, diskBytes: data.spent?.diskBytes ?? 0 },
    verdict: data.verdict ?? null, reviewer,
    evidence: acceptanceEvidence({ findings: data.findings, verified: data.output?.verifiedDimensions ?? inspect?.verified ?? [], unverified: data.output?.unverified ?? data.verdict?.unverified ?? [] }),
    findings: [...(data.findings || [])].sort((a, b) => (a.atSeconds ?? -1) - (b.atSeconds ?? -1)),
    repairs: data.repairs ?? [], frames, pilots,
    output: data.output ? { videoId: data.output.videoId, path: data.output.path, revisionId: data.output.revisionId, sourceHash: data.output.sourceHash } : null,
    acceptable: acceptanceProblem(run) === null,
    error: data.error ?? null,
  };
}
