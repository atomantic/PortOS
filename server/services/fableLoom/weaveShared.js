/** FableLoom workflow record lookup, stage options, and request-scoped AI status. */

import { ServerError } from '../../lib/errorHandler.js';
import { startAIOp } from '../aiStatusEvents.js';
import { runStagedLLM } from '../stageRunner.js';
import { getLoom } from './records.js';

export const aiShapeError = (message) =>
  new ServerError(message, { status: 502, code: 'AI_RESPONSE_INVALID' });

export const requireLoom = async (loomId) => {
  const loom = await getLoom(loomId);
  if (!loom) throw new ServerError('Loom not found', { status: 404, code: 'NOT_FOUND' });
  return loom;
};

export const llmOptions = ({ providerId, model, effort } = {}, source) => ({
  source,
  returnsJson: true,
  ...(providerId ? { providerOverride: providerId } : {}),
  ...(model ? { modelOverride: model } : {}),
  ...(effort ? { effortOverride: effort } : {}),
});

// FableLoom edits are one HTTP request but can spend minutes inside a TUI. The
// operation id is minted by the requesting view, so status frames cannot be
// mistaken for a different loom or a stale run in another tab. The normal
// `ai:status` channel carries these frames; `localOnly` keeps the global toast
// surface from duplicating the drawer's inline status and error message.
export const createLoomAiStatus = (route, { action, label }) => route.operationId
    ? startAIOp({
      op: `fableloom-${action}`,
      label,
      operationId: route.operationId,
      localOnly: true,
      silent: true,
    })
  : null;

export const runLoomAi = (stage, variables, route, {
  action, label, source, status: existingStatus = null, complete = true,
}) => {
  const status = existingStatus || createLoomAiStatus(route, { action, label });
  const options = llmOptions(route, source);
  if (status) {
    options.onRunCreated = (runId, meta = {}) => status.update(
      'running',
      `${label} is running…`,
      { ...meta, runId, shellReady: false },
    );
    options.onRunReady = (meta = {}) => status.update(
      'ready',
      'TUI run is ready — open Shell to watch and interact',
      meta,
    );
    options.onRunSettled = (runId) => status.update(
      'applying',
      'AI response received — applying changes…',
      { runId },
    );
  }
  return runStagedLLM(stage, variables, options).then((result) => {
    if (complete) status?.complete('AI response ready', { runId: result.runId, shellReady: false });
    return result;
  }, (error) => {
    status?.error(
      error?.message || 'AI operation failed',
      error?.runId ? { runId: error.runId } : {},
    );
    throw error;
  });
};
