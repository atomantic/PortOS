/** Runtime-backed payload contracts for modeled Socket.IO events. */

import { zodToOpenApiSchema } from './apiContractSchemas.js';
import {
  appDeploySchema,
  appStandardizeSchema,
  appUpdateSchema,
  detectStartSchema,
  errorRecoverSchema,
  itermInputSchema,
  itermSessionRefSchema,
  logsSubscribeSchema,
  logsUnsubscribeSchema,
  shellAttachSchema,
  shellCdSchema,
  shellInputSchema,
  shellResizeSchema,
  shellStopSchema,
  standardizeStartSchema,
} from './socketValidation.js';

const input = (schema, summary) => Object.freeze({
  direction: 'client-to-server',
  summary,
  payloadSchema: zodToOpenApiSchema(schema),
});

export const SOCKET_EVENT_CONTRACTS = Object.freeze({
  'app:deploy': input(appDeploySchema, 'Deploy a managed app with allowlisted flags.'),
  'app:standardize': input(appStandardizeSchema, 'Standardize one registered app.'),
  'app:update': input(appUpdateSchema, 'Run the update lifecycle for one registered app.'),
  'detect:start': input(detectStartSchema, 'Start streamed application detection.'),
  'error:recover': input(errorRecoverSchema, 'Request a bounded recovery task for a reported error.'),
  'fableloom:fal-video:changed': Object.freeze({
    direction: 'server-to-client',
    summary: 'Public browser video job snapshot on queue, progress and terminal transitions; completion follows durable gallery and scene attachment.',
    payloadSchema: {
      type: 'object',
      required: ['id', 'source', 'loomId', 'episodeId', 'nodeId', 'status', 'statusMsg', 'progress',
        'createdAt', 'startedAt', 'completedAt', 'error', 'videoHistoryId', 'filename'],
      properties: {
        id: { type: 'string' },
        source: { type: 'string', enum: ['fal-browser'] },
        loomId: { type: 'string' },
        episodeId: { type: 'string' },
        nodeId: { type: 'string' },
        status: { type: 'string', enum: ['queued', 'running', 'completed', 'failed'] },
        statusMsg: { type: 'string' },
        progress: { type: 'number', minimum: 0, maximum: 1 },
        createdAt: { type: 'string' },
        startedAt: { type: ['string', 'null'] },
        completedAt: { type: ['string', 'null'] },
        error: { type: ['string', 'null'] },
        videoHistoryId: { type: ['string', 'null'] },
        filename: { type: ['string', 'null'] },
      },
      additionalProperties: false,
    },
  }),
  'iterm:attach': input(itermSessionRefSchema, 'Start viewing one live iTerm2 session.'),
  'iterm:detach': input(itermSessionRefSchema, 'Stop viewing one live iTerm2 session.'),
  'iterm:input': input(itermInputSchema, 'Type bytes into one live iTerm2 session.'),
  'localLlm:sweep:changed': Object.freeze({
    direction: 'server-to-client',
    summary: 'Public assessment sweep snapshot after a queue state change, including cancellation and final runtime restoration.',
    payloadSchema: {
      type: 'object',
      required: ['status', 'settled', 'total', 'completed', 'results', 'cancelRequested'],
      properties: {
        status: { type: 'string', enum: ['idle', 'running', 'cancelled', 'failed', 'complete'] },
        mode: { type: ['string', 'null'], enum: ['models', 'tunings', null] },
        scope: { type: ['string', 'null'] },
        target: { type: ['object', 'null'], properties: { backend: { type: 'string' }, modelId: { type: 'string' } } },
        settled: { type: 'boolean' },
        startedAt: { type: ['string', 'null'] },
        finishedAt: { type: ['string', 'null'] },
        total: { type: 'integer' },
        completed: { type: 'integer' },
        current: { type: ['object', 'null'], properties: {
          backend: { type: 'string' }, modelId: { type: 'string' },
          tuningLabel: { type: ['string', 'null'] }, startedAt: { type: 'string' },
        } },
        results: { type: 'array', items: { type: 'object', properties: {
          backend: { type: 'string' }, modelId: { type: 'string' },
          tuningLabel: { type: ['string', 'null'] }, finishedAt: { type: 'string' },
          verdict: { type: ['string', 'null'] }, error: { type: ['string', 'null'] },
          meanTokensPerSecond: { type: ['number', 'null'] }, meanCharsPerSecond: { type: ['number', 'null'] },
          tokensEstimated: { type: ['boolean', 'null'] }, tuningApplied: { type: ['boolean', 'null'] },
          tuningNotApplied: { type: ['string', 'null'] },
        } } },
        cancelRequested: { type: 'boolean' },
        error: { type: ['string', 'null'] },
        restoreError: { type: ['string', 'null'] },
      },
      additionalProperties: false,
    },
  }),
  'logs:subscribe': input(logsSubscribeSchema, 'Subscribe to a bounded process-log tail.'),
  'logs:unsubscribe': input(logsUnsubscribeSchema, 'Release one process-log subscription or all legacy subscriptions.'),
  'shell:attach': input(shellAttachSchema, 'Attach this socket to an existing terminal session.'),
  'shell:cd': input(shellCdSchema, 'Change an existing terminal session directory.'),
  'shell:input': input(shellInputSchema, 'Write bytes to an existing terminal session.'),
  'shell:resize': input(shellResizeSchema, 'Resize an existing terminal session.'),
  'shell:stop': input(shellStopSchema, 'Stop an existing terminal session.'),
  'standardize:start': input(standardizeStartSchema, 'Start streamed PM2 standardization for a repository.'),
});

export const socketEventContract = (event, direction) => {
  const contract = SOCKET_EVENT_CONTRACTS[event];
  return contract?.direction === direction ? contract : null;
};
