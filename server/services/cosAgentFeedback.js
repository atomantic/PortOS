/**
 * CoS Agent Feedback Module
 *
 * Per-agent feedback capture + aggregation and the task-type classifier.
 * Extracted from the former monolithic cosAgents.js (issue #2530).
 *
 * The `cosAgents.js` barrel that used to re-export this module is retired
 * (#3450) — callers import from here directly.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { cosEvents, emitLog } from './cosEvents.js';
import { loadState, saveState, withStateLock, AGENTS_DIR } from './cosState.js';
import { atomicWrite, safeJSONParse, tryReadFile } from '../lib/fileUtils.js';
import { loadAgentIndex, getAgentDir } from './cosAgentIndex.js';
import { ServerError } from '../lib/errorHandler.js';
import { recordUserAction } from './userActions.js';

const isSystemAgent = (agent) =>
  agent.taskId?.startsWith('sys-') || agent.id?.startsWith('sys-');

// Only agents spawned from a manually-filled task form are worth asking the
// user to rate. Scheduled-task and autopilot runs carry taskType 'internal'
// and already get an automatic success/failure verdict from task-learning
// (buildTaskTelemetryContext's outcomeSuccess) — asking for a manual rating
// on top of that is redundant nagging, not a useful signal.
const isManualUserAgent = (agent) => agent.metadata?.taskType === 'user';

const FEEDBACK_RATINGS = new Set(['positive', 'negative', 'neutral']);
const ARCHIVE_READ_BATCH_SIZE = 50;

const hasValidFeedback = (agent) => FEEDBACK_RATINGS.has(agent?.feedback?.rating);

// Completed agents are written to their date-bucket archive before they age out
// of live state. Feedback statistics therefore have to read both stores and
// de-duplicate by agent id; reading state alone makes almost all historical
// ratings disappear from the learning view as soon as normal retention runs.
async function loadArchivedAgentsWithFeedback() {
  const idx = await loadAgentIndex();
  const entries = [...idx.entries()];
  const agents = [];

  // Match the archive reader's bounded fan-out so a long-lived install does not
  // open every metadata file at once.
  for (let i = 0; i < entries.length; i += ARCHIVE_READ_BATCH_SIZE) {
    const batch = entries.slice(i, i + ARCHIVE_READ_BATCH_SIZE);
    const reads = batch.map(async ([agentId, dateBucket]) => {
      const content = await tryReadFile(join(getAgentDir(agentId, dateBucket), 'metadata.json'));
      if (!content) return null;
      const raw = safeJSONParse(content, null);
      return hasValidFeedback(raw) ? { ...raw, id: raw.id || raw.agentId || agentId } : null;
    });
    const settled = await Promise.allSettled(reads);
    for (const result of settled) {
      if (result.status === 'fulfilled' && result.value) agents.push(result.value);
    }
  }

  return agents;
}

// Count completed user-facing agents that are still retained in live CoS state
// and have not received a rating. Archived history is intentionally excluded:
// actionable insights refresh every 30s, so this remains a cheap, exact count
// of the recent runs a user can immediately review in the Agents queue.
export async function getPendingAgentFeedbackCount() {
  const state = await loadState();
  return Object.values(state.agents)
    .filter(agent =>
      agent.status === 'completed' &&
      !isSystemAgent(agent) &&
      isManualUserAgent(agent) &&
      !agent.feedback?.rating)
    .length;
}

// Submit feedback for a completed agent.
//
// The operator-action ledger write (#5594) happens AFTER the state lock releases,
// not inside it: a rating is a human verdict every caller should record, so it
// belongs at this one boundary rather than in the HTTP route — but nesting a DB
// write inside the CoS state lock would hold the lock across an I/O round trip
// for a log line. The lock's own failures still reject before anything is logged.
export async function submitAgentFeedback(agentId, feedback) {
  const result = await withStateLock(async () => {
    const state = await loadState();
    const feedbackData = {
      rating: feedback.rating,
      comment: feedback.comment || null,
      submittedAt: new Date().toISOString()
    };

    // Try state first (recently completed agents still in state)
    if (state.agents[agentId]) {
      const agent = state.agents[agentId];
      if (agent.status !== 'completed') {
        throw new ServerError('Can only submit feedback for completed agents', { status: 400, code: 'INVALID_STATE' });
      }
      state.agents[agentId].feedback = feedbackData;
      await saveState(state);

      // Also update on-disk metadata (derive date bucket from completedAt if archived)
      const dateBucket = agent.completedAt ? agent.completedAt.slice(0, 10) : null;
      const agentDir = getAgentDir(agentId, dateBucket);
      const metaPath = join(agentDir, 'metadata.json');
      if (existsSync(metaPath)) {
        const content = await tryReadFile(metaPath);
        if (content) {
          const raw = safeJSONParse(content, null);
          if (raw) {
            raw.feedback = feedbackData;
            await atomicWrite(metaPath, raw).catch(() => {});
          }
        }
      }

      emitLog('info', `Feedback received for agent ${agentId}: ${feedback.rating}`, { agentId, rating: feedback.rating });
      cosEvents.emit('agent:feedback', { agentId, feedback: feedbackData });
      return { success: true, agent: state.agents[agentId], feedbackData };
    }

    // Agent not in state — look up from disk via index
    const idx = await loadAgentIndex();
    const dateStr = idx.get(agentId);
    if (!dateStr) throw new ServerError('Agent not found', { status: 404, code: 'NOT_FOUND' });

    const metaPath = join(AGENTS_DIR, dateStr, agentId, 'metadata.json');
    const content = await tryReadFile(metaPath);
    if (!content) throw new ServerError('Agent not found', { status: 404, code: 'NOT_FOUND' });

    const raw = safeJSONParse(content, null);
    if (!raw) throw new ServerError('Agent not found', { status: 404, code: 'NOT_FOUND' });

    raw.feedback = feedbackData;
    await atomicWrite(metaPath, raw);

    emitLog('info', `Feedback received for agent ${agentId}: ${feedback.rating}`, { agentId, rating: feedback.rating });
    cosEvents.emit('agent:feedback', { agentId, feedback: feedbackData });
    return { success: true, agent: { ...raw, id: agentId }, feedbackData };
  });

  const { feedbackData, ...response } = result;
  await recordUserAction({
    type: 'cos.agent.feedback',
    target: agentId,
    targetName: response.agent?.metadata?.taskDescription,
    summary: `Rated agent ${agentId} ${feedbackData.rating}`,
    payload: {
      agentId,
      taskId: response.agent?.taskId ?? null,
      rating: feedbackData.rating,
      comment: feedbackData.comment,
      taskType: extractTaskType(response.agent?.metadata?.taskDescription),
    },
    source: { service: 'cosAgentFeedback', fn: 'submitAgentFeedback' },
    happenedAt: feedbackData.submittedAt,
    dedupeKey: `cos.agent.feedback:${agentId}:${feedbackData.submittedAt}`,
  });
  return response;
}

// Get aggregated feedback statistics
export async function getFeedbackStats() {
  const state = await loadState();
  const archived = await loadArchivedAgentsWithFeedback();
  const byAgentId = new Map(archived.map(agent => [agent.id, agent]));

  // Live state is freshest, but only overwrite an archived rating when the live
  // record actually carries valid feedback. This preserves a durable rating if
  // a prior best-effort live-state update did not make it into both stores.
  for (const [agentId, agent] of Object.entries(state.agents)) {
    if (hasValidFeedback(agent)) byAgentId.set(agent.id || agentId, agent);
  }

  const withFeedback = [...byAgentId.values()];
  const positive = withFeedback.filter(a => a.feedback.rating === 'positive').length;
  const negative = withFeedback.filter(a => a.feedback.rating === 'negative').length;
  const neutral = withFeedback.filter(a => a.feedback.rating === 'neutral').length;

  // Group by task type
  const byTaskType = {};
  withFeedback.forEach(a => {
    const taskType = extractTaskType(a.metadata?.taskDescription);
    if (!byTaskType[taskType]) {
      byTaskType[taskType] = { positive: 0, negative: 0, neutral: 0, total: 0 };
    }
    byTaskType[taskType][a.feedback.rating]++;
    byTaskType[taskType].total++;
  });

  // Recent feedback (last 10 with comments)
  const recentWithComments = withFeedback
    .filter(a => a.feedback.comment)
    .sort((a, b) => new Date(b.feedback.submittedAt) - new Date(a.feedback.submittedAt))
    .slice(0, 10)
    .map(a => ({
      agentId: a.id,
      taskDescription: a.metadata?.taskDescription,
      rating: a.feedback.rating,
      comment: a.feedback.comment,
      submittedAt: a.feedback.submittedAt
    }));

  const satisfactionRate = withFeedback.length > 0
    ? Math.round((positive / withFeedback.length) * 100)
    : null;

  return {
    total: withFeedback.length,
    positive,
    negative,
    neutral,
    satisfactionRate,
    byTaskType,
    recentWithComments
  };
}

// Helper to extract task type from description (mirrors client-side logic)
export function extractTaskType(description) {
  if (!description) return 'general';
  const d = description.toLowerCase();
  if (d.includes('fix') || d.includes('bug') || d.includes('error') || d.includes('issue')) return 'bug-fix';
  if (d.includes('refactor') || d.includes('clean up') || d.includes('improve') || d.includes('optimize')) return 'refactor';
  if (d.includes('test')) return 'testing';
  if (d.includes('document') || d.includes('readme') || d.includes('docs')) return 'documentation';
  if (d.includes('review') || d.includes('audit')) return 'code-review';
  if (d.includes('mobile') || d.includes('responsive')) return 'mobile-responsive';
  if (d.includes('security') || d.includes('vulnerability')) return 'security';
  if (d.includes('performance') || d.includes('speed')) return 'performance';
  if (d.includes('ui') || d.includes('ux') || d.includes('design') || d.includes('style')) return 'ui-ux';
  if (d.includes('api') || d.includes('endpoint') || d.includes('route')) return 'api';
  if (d.includes('database') || d.includes('migration')) return 'database';
  if (d.includes('deploy') || d.includes('ci') || d.includes('cd')) return 'devops';
  if (d.includes('investigate') || d.includes('debug')) return 'investigation';
  if (d.includes('self-improvement') || d.includes('feature idea')) return 'self-improvement';
  return 'feature';
}
