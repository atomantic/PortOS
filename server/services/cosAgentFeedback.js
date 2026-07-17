/**
 * CoS Agent Feedback Module
 *
 * Per-agent feedback capture + aggregation and the task-type classifier.
 * Extracted from the former monolithic cosAgents.js (issue #2530).
 *
 * The public barrel `cosAgents.js` re-exports everything here.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { cosEvents, emitLog } from './cosEvents.js';
import { loadState, saveState, withStateLock, AGENTS_DIR } from './cosState.js';
import { atomicWrite, safeJSONParse, tryReadFile } from '../lib/fileUtils.js';
import { loadAgentIndex, getAgentDir } from './cosAgentIndex.js';
import { ServerError } from '../lib/errorHandler.js';

// Submit feedback for a completed agent
export async function submitAgentFeedback(agentId, feedback) {
  return withStateLock(async () => {
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
      return { success: true, agent: state.agents[agentId] };
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
    return { success: true, agent: { ...raw, id: agentId } };
  });
}

// Get aggregated feedback statistics
export async function getFeedbackStats() {
  const state = await loadState();
  const agents = Object.values(state.agents);

  const withFeedback = agents.filter(a => a.feedback);
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
