/**
 * Reviewer verdicts on the run that asked for them (#16572).
 *
 * The orchestrating agent reports each CLI review round to
 * `POST /api/code-review/cli-outcome`; when the report names its run, the
 * verdict, round and reviewed changed-line count are appended to that run's
 * `metadata.reviewVerdicts`, which travels into the archived `metadata.json`
 * like every other agent field. No separate store. Recording never changes
 * when or whether review runs.
 *
 * The Learning view reads `getReviewerVerdictStats()`: clean rate per reviewer
 * and per diff-size bucket over live and archived runs. Runs written before this
 * field existed simply contribute nothing.
 */

// Bounds one run's record: a review loop that somehow reports past this keeps
// its earliest rounds, which are the ones the clean-rate question is about.
const MAX_REVIEW_VERDICTS_PER_RUN = 200;

/** Inclusive upper bounds on reviewed added+deleted lines; the last bucket is open. */
const REVIEW_SIZE_BUCKETS = [
  { id: 'xs', label: '0-20 lines', max: 20 },
  { id: 's', label: '21-100 lines', max: 100 },
  { id: 'm', label: '101-500 lines', max: 500 },
  { id: 'l', label: '501+ lines', max: Infinity },
];

const isCount = (value) => Number.isSafeInteger(value) && value >= 0;

/** A persisted entry is trusted only in the shape this module writes; anything else is skipped. */
function isVerdictEntry(entry) {
  return entry && typeof entry === 'object'
    && typeof entry.reviewer === 'string' && entry.reviewer.length > 0
    && (entry.verdict === 'clean' || entry.verdict === 'findings')
    && (entry.round == null || (isCount(entry.round) && entry.round > 0))
    && (entry.changedLines == null || isCount(entry.changedLines));
}

function sizeBucketFor(changedLines) {
  if (!isCount(changedLines)) return 'unknown';
  return REVIEW_SIZE_BUCKETS.find(bucket => changedLines <= bucket.max).id;
}

/**
 * Append one verdict to a running agent's record. A report naming a missing or
 * finished run is refused rather than written somewhere else.
 *
 * @returns {Promise<{runRecorded: boolean, reason?: string}>}
 */
export async function recordReviewerVerdict({ agentId, reviewer, verdict, round, changedLines }) {
  const { withStateLock, loadState, saveState } = await import('./cosState.js');
  return withStateLock(async () => {
    const state = await loadState();
    const agent = state.agents?.[agentId];
    if (!agent || agent.status !== 'running') return { runRecorded: false, reason: 'run-not-running' };
    const prior = Array.isArray(agent.metadata?.reviewVerdicts) ? agent.metadata.reviewVerdicts : [];
    if (prior.length >= MAX_REVIEW_VERDICTS_PER_RUN) return { runRecorded: false, reason: 'run-verdict-limit' };
    const entry = { reviewer, verdict, recordedAt: new Date().toISOString(),
      ...(round != null && { round }), ...(changedLines != null && { changedLines }) };
    const updated = { ...agent, metadata: { ...agent.metadata, reviewVerdicts: [...prior, entry] } };
    state.agents[agentId] = updated;
    await saveState(state, { changedAgentIds: [agentId] });
    const { cosEvents } = await import('./cosEvents.js');
    cosEvents.emit('agent:updated', updated);
    // The Learning tab re-reads its aggregate on this instead of polling.
    cosEvents.emit('reviewer-verdict:recorded', { agentId, reviewer, verdict });
    return { runRecorded: true };
  });
}

const emptyTally = () => ({ reports: 0, clean: 0, findings: 0, cleanRate: null });
function tally(bucket, verdict) {
  bucket.reports++;
  bucket[verdict]++;
}
const withRate = (bucket) => ({ ...bucket, cleanRate: bucket.reports ? Math.round((bucket.clean / bucket.reports) * 100) : null });

/**
 * Pure aggregate over agent records. Each reported round counts once; a run's
 * round count for a reviewer is the highest round it reported (or its number of
 * reports when the rounds were not numbered).
 */
function summarizeReviewerVerdicts(agents) {
  const byReviewer = new Map();
  const bySize = new Map([...REVIEW_SIZE_BUCKETS.map(b => [b.id, emptyTally()]), ['unknown', emptyTally()]]);
  let runs = 0;
  for (const agent of agents) {
    const entries = Array.isArray(agent?.metadata?.reviewVerdicts) ? agent.metadata.reviewVerdicts.filter(isVerdictEntry) : [];
    if (!entries.length) continue;
    runs++;
    const roundsThisRun = new Map();
    for (const entry of entries) {
      const reviewer = byReviewer.get(entry.reviewer) || { ...emptyTally(), runs: 0, totalRounds: 0 };
      byReviewer.set(entry.reviewer, reviewer);
      tally(reviewer, entry.verdict);
      tally(bySize.get(sizeBucketFor(entry.changedLines)), entry.verdict);
      const seen = roundsThisRun.get(entry.reviewer) || { max: 0, count: 0 };
      roundsThisRun.set(entry.reviewer, { max: Math.max(seen.max, entry.round || 0), count: seen.count + 1 });
    }
    for (const [name, seen] of roundsThisRun) {
      const reviewer = byReviewer.get(name);
      reviewer.runs++;
      reviewer.totalRounds += seen.max || seen.count;
    }
  }
  const reviewers = [...byReviewer.entries()]
    .map(([reviewer, { totalRounds, ...counts }]) => ({
      reviewer, ...withRate(counts), avgRounds: counts.runs ? Math.round((totalRounds / counts.runs) * 10) / 10 : null,
    }))
    .sort((a, b) => b.reports - a.reports || a.reviewer.localeCompare(b.reviewer));
  const sizes = [...REVIEW_SIZE_BUCKETS, { id: 'unknown', label: 'Size not reported' }]
    .map(({ id, label }) => ({ bucket: id, label, ...withRate(bySize.get(id)) }));
  return { runs, reports: reviewers.reduce((sum, r) => sum + r.reports, 0), byReviewer: reviewers, bySize: sizes };
}

/**
 * Live working set plus the dated archive, de-duplicated by agent id (live wins).
 * `unreadableRuns` counts archived records that could not be read this time.
 */
export async function getReviewerVerdictStats() {
  // Lazy imports keep the archive and CoS state out of this module's static graph.
  const [{ loadState }, { scanArchivedAgents }] = await Promise.all([import('./cosState.js'), import('./cosArchivedAgentScan.js')]);
  const { byId: archived, unreadable } = await scanArchivedAgents();
  const state = await loadState();
  const byId = new Map();
  for (const [agentId, { verdicts }] of archived) {
    if (verdicts) byId.set(agentId, { metadata: { reviewVerdicts: verdicts } });
  }
  for (const [agentId, agent] of Object.entries(state.agents || {})) byId.set(agent.id || agentId, agent);
  // Rates exclude these runs, so the view says how many could not be read rather
  // than presenting a partial aggregate as complete.
  return { ...summarizeReviewerVerdicts([...byId.values()]), unreadableRuns: unreadable };
}
