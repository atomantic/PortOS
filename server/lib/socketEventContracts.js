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

const loomRunSnapshot = (production) => Object.freeze({
  direction: 'server-to-client',
  summary: 'Revisioned public FableLoom run snapshot after an authoritative transition; no runtime handles.',
  payloadSchema: {
    type: 'object',
    required: ['id', 'loomId', 'status', 'revision', 'createdAt', 'updatedAt', ...(production ? ['episodeId', 'attempt', 'assets', 'summary'] : [])],
    properties: {
      id: { type: 'string' },
      loomId: { type: 'string' },
      ...(production ? { episodeId: { type: 'string' }, attempt: { type: 'integer' }, assets: { type: 'array', items: { type: 'object' } }, summary: { type: 'object' } } : {}),
      status: { type: 'string', enum: production ? ['in_progress', 'completed', 'failed', 'canceled'] : ['running', 'canceling', 'completed', 'paused', 'failed', 'canceled'] },
      revision: { type: 'integer' },
      createdAt: { type: 'string' },
      updatedAt: { type: 'string' },
    },
  },
});

export const SOCKET_EVENT_CONTRACTS = Object.freeze({
  'portos:auto-update:changed': {
    direction: 'server-to-client',
    summary: 'Invalidate updater status after runtime, configuration or external git ref changes.',
    payloadSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  'brain:changed': {
    direction: 'server-to-client',
    summary: 'Invalidate Brain summary/settings after a persisted change.',
    payloadSchema: { type: 'object', properties: { type: { type: 'string' }, id: { type: 'string' } }, required: ['type'], additionalProperties: false },
  },
  'brain:links:changed': {
    direction: 'server-to-client',
    summary: 'Invalidate one link including clone progress and scan-report completion.',
    payloadSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
  },

  'creative-director:project:changed': Object.freeze({
    direction: 'server-to-client',
    summary: 'A Creative Director project changed after persistence; fetch only a referenced project.',
    payloadSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } }, additionalProperties: false },
  }),
  'commission:changed': Object.freeze({
    direction: 'server-to-client',
    summary: 'A creative commission changed after persistence.',
    payloadSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } }, additionalProperties: false },
  }),
  'fableloom:editorial:run': loomRunSnapshot(false),
  'fableloom:production:run': loomRunSnapshot(true),
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
  'processes:changed': Object.freeze({
    direction: 'server-to-client',
    summary: 'PM2 snapshot for registered apps sharing a home; null means the probe failed.',
    payloadSchema: {
      type: 'object', required: ['appIds', 'defaultHome', 'processes'],
      properties: {
        appIds: { type: 'array', items: { type: 'string' } },
        defaultHome: { type: 'boolean' },
        processes: { type: ['array', 'null'], items: { type: 'object', properties: {
          name: { type: 'string' }, status: { type: 'string' }, pid: { type: 'number' },
          pm_id: { type: 'number' }, cpu: { type: 'number' }, memory: { type: 'number' },
          uptime: { type: ['number', 'null'] }, restarts: { type: 'number' }, unstableRestarts: { type: 'number' }
        } } }
      }
    }
  }),
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
