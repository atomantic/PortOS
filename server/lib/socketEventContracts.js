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
        mode: { type: 'string', nullable: true, enum: ['models', 'tunings'] },
        scope: { type: 'string', nullable: true },
        target: { type: 'object', nullable: true, properties: { backend: { type: 'string' }, modelId: { type: 'string' } } },
        settled: { type: 'boolean' },
        startedAt: { type: 'string', nullable: true },
        finishedAt: { type: 'string', nullable: true },
        total: { type: 'integer' },
        completed: { type: 'integer' },
        current: { type: 'object', nullable: true, properties: {
          backend: { type: 'string' }, modelId: { type: 'string' },
          tuningLabel: { type: 'string', nullable: true }, startedAt: { type: 'string' },
        } },
        results: { type: 'array', items: { type: 'object', properties: {
          backend: { type: 'string' }, modelId: { type: 'string' },
          tuningLabel: { type: 'string', nullable: true }, finishedAt: { type: 'string' },
          verdict: { type: 'string', nullable: true }, error: { type: 'string', nullable: true },
          meanTokensPerSecond: { type: 'number', nullable: true }, meanCharsPerSecond: { type: 'number', nullable: true },
          tokensEstimated: { type: 'boolean', nullable: true }, tuningApplied: { type: 'boolean', nullable: true },
          tuningNotApplied: { type: 'string', nullable: true },
        } } },
        cancelRequested: { type: 'boolean' },
        error: { type: 'string', nullable: true },
        restoreError: { type: 'string', nullable: true },
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
