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
  'fleet-host:subscribe': {
    direction: 'client-to-server', summary: 'Observe local fleet host readiness while this operator socket is subscribed.',
    payloadSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  'fleet-host:unsubscribe': {
    direction: 'client-to-server', summary: 'Release this operator socket; stop external probes after the last subscriber leaves.',
    payloadSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  'fleet-host:changed': {
    direction: 'server-to-client', summary: 'Local host readiness or setup changed; no credentials or records.',
    payloadSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  'fleet-host:usage:changed': {
    direction: 'server-to-client', summary: 'Local queue or usage ledger changed; read the authenticated usage report.',
    payloadSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  'reference-sheet:changed': {
    direction: 'server-to-client',
    summary: 'Correlated sheet publication outcome after the image copy and character pointer write finish.',
    payloadSchema: {
      type: 'object', required: ['universeId', 'entryId', 'jobId', 'variant', 'status'],
      properties: {
        universeId: { type: 'string' }, entryId: { type: 'string' },
        jobId: { type: 'string' }, variant: { type: 'string' },
        status: { type: 'string', enum: ['ready', 'failed', 'superseded'] },
      },
      additionalProperties: false,
    },
  },
  'eidoverse:projection': {
    direction: 'server-to-client',
    summary: 'Payload-free invalidation after persisted Eidoverse world changes; clients read projection progress through the authenticated API.',
    payloadSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  'jev:status': {
    direction: 'server-to-client',
    summary: 'JEV install or sidecar lifecycle changed; reread status without loading a model.',
    payloadSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  'jev:stats': {
    direction: 'server-to-client',
    summary: 'JEV decision counters persisted; reread aggregate statistics.',
    payloadSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  'jev:heads': {
    direction: 'server-to-client',
    summary: 'JEV head artifacts or training state changed; reread head metadata.',
    payloadSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  'jev:policy': {
    direction: 'server-to-client',
    summary: 'Invalidate Jev integration policy after settings persistence or restore invalidation; no settings content.',
    payloadSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  'laya:status': {
    direction: 'server-to-client',
    summary: 'Invalidate Laya runtime status after install progress, completion, failure or scoring transitions; no experiment content.',
    payloadSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  'usage-backfill:updated': {
    direction: 'server-to-client',
    summary: 'Invalidate historical usage backfill status after progress or a durable terminal transition.',
    payloadSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  'cos:day:changed': {
    direction: 'server-to-client',
    summary: 'Invalidate UTC-day aggregates when the current activity-calendar day expires.',
    payloadSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  'goals:changed': {
    direction: 'server-to-client',
    summary: 'Invalidate goals after a local write or peer merge.',
    payloadSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  'backup:changed': {
    direction: 'server-to-client',
    summary: 'Invalidate backup status and snapshots after lifecycle or configuration changes.',
    payloadSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  'cos:decisions:changed': {
    direction: 'server-to-client',
    summary: 'Invalidate the decision summary after an appended or collapsed decision.',
    payloadSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  'cos:schedule:changed': {
    direction: 'server-to-client',
    summary: 'Invalidate upcoming tasks after schedule persistence.',
    payloadSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  'cos:scheduler:changed': {
    direction: 'server-to-client',
    summary: 'Invalidate upcoming tasks after scheduler registration, cancellation or execution.',
    payloadSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  'cos:agents:changed': {
    direction: 'server-to-client',
    summary: 'Invalidate agent aggregates after deletion or cleanup.',
    payloadSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  'cos:learning:changed': {
    direction: 'server-to-client',
    summary: 'Invalidate learning aggregates and upcoming estimates after persistence.',
    payloadSchema: { type: 'object', properties: {}, additionalProperties: false },
  },

  'agent-processes:subscribe': {
    direction: 'client-to-server',
    summary: 'Subscribe to shared agent process snapshots while the page is mounted.',
    payloadSchema: { type: 'null' },
  },
  'agent-processes:unsubscribe': {
    direction: 'client-to-server',
    summary: 'Release agent process snapshots; the last subscriber stops host scans.',
    payloadSchema: { type: 'null' },
  },
  'agent-processes:changed': {
    direction: 'server-to-client',
    summary: 'Agent process snapshot after process or resource usage changes.',
    payloadSchema: {
      type: 'object', required: ['agents'],
      properties: { agents: { type: 'array', items: { type: 'object' } } },
    },
  },
  'digital-twin:changed': {
    direction: 'server-to-client',
    summary: 'Invalidate Digital Twin status/settings after persistence or completed peer sync; contains no personal data.',
    payloadSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  'meatspace:death-clock:changed': {
    direction: 'server-to-client',
    summary: 'Invalidate death-clock projection after local or federated inputs change.',
    payloadSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  'cos:mind:visibility': {
    direction: 'server-to-client',
    summary: 'Coalesced environment visibility invalidation for subscribed CoS views; no private records.',
    payloadSchema: { type: 'object', required: ['invalidated'], properties: { invalidated: { type: 'boolean', enum: [true] } }, additionalProperties: false },
  },
  'cos:goals:changed': {
    direction: 'server-to-client',
    summary: 'Invalidate operational goal progress after learning statistics persist.',
    payloadSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  'meatspace:changed': {
    direction: 'server-to-client',
    summary: 'Overview resource invalidation after persisted local or mirrored health changes.',
    payloadSchema: { type: 'object', required: ['resources'], additionalProperties: false,
      properties: { resources: { type: 'array', items: { type: 'string', enum: ['overview', 'alcohol', 'body', 'healthBody', 'blood', 'epigenetic', 'eyes', 'calendar'] } } } },
  },
  'portos:auto-update:changed': {
    direction: 'server-to-client',
    summary: 'Invalidate updater status after runtime, configuration or external git ref changes.',
    payloadSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  'system:health:changed': {
    direction: 'server-to-client',
    summary: 'Invalidate health after a service change or changed shared readiness sample.',
    payloadSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  'capabilities:changed': {
    direction: 'server-to-client',
    summary: 'Invalidate capabilities after a persisted change or changed readiness sample.',
    payloadSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  'browser:changed': {
    direction: 'server-to-client',
    summary: 'Shared browser snapshot or read failure changed; reread the cached status.',
    payloadSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  'browser:subscribe': {
    direction: 'client-to-server',
    summary: 'Observe external browser state while the Browser view is mounted; never launches or navigates.',
    payloadSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  'browser:unsubscribe': {
    direction: 'client-to-server',
    summary: 'Release browser observation; the last subscriber stops the observer.',
    payloadSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  'loaded-models:subscribe': {
    direction: 'client-to-server',
    summary: 'Start shared observation while a viewer is mounted.',
    payloadSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  'loaded-models:unsubscribe': {
    direction: 'client-to-server',
    summary: 'Release observation; the last viewer stops sampling.',
    payloadSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  'loaded-models:changed': {
    direction: 'server-to-client',
    summary: 'Shared sample changed or failed; reconcile through the existing status endpoint.',
    payloadSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  'voice-readiness:subscribe': {
    direction: 'client-to-server',
    summary: 'Start shared observation while a viewer is mounted.',
    payloadSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  'voice-readiness:unsubscribe': {
    direction: 'client-to-server',
    summary: 'Release observation; the last viewer stops sampling.',
    payloadSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  'voice-readiness:changed': {
    direction: 'server-to-client',
    summary: 'Shared sample changed or failed; reconcile through the existing status endpoint.',
    payloadSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  'provider-readiness:subscribe': {
    direction: 'client-to-server',
    summary: 'Start shared observation while a viewer is mounted.',
    payloadSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  'provider-readiness:unsubscribe': {
    direction: 'client-to-server',
    summary: 'Release observation; the last viewer stops sampling.',
    payloadSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  'provider-readiness:changed': {
    direction: 'server-to-client',
    summary: 'Shared sample changed or failed; reconcile through the existing status endpoint.',
    payloadSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  'provider-status:subscribe': {
    direction: 'client-to-server',
    summary: 'Start shared observation while a viewer is mounted.',
    payloadSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  'provider-status:unsubscribe': {
    direction: 'client-to-server',
    summary: 'Release observation; the last viewer stops sampling.',
    payloadSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  'provider-status:changed': {
    direction: 'server-to-client',
    summary: 'Shared sample changed or failed; reconcile through the existing status endpoint.',
    payloadSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  'codex-account:subscribe': {
    direction: 'client-to-server',
    summary: 'Start shared observation while a viewer is mounted.',
    payloadSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  'codex-account:unsubscribe': {
    direction: 'client-to-server',
    summary: 'Release observation; the last viewer stops sampling.',
    payloadSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  'codex-account:changed': {
    direction: 'server-to-client',
    summary: 'Shared sample changed or failed; reconcile through the existing status endpoint.',
    payloadSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  'readiness:subscribe': {
    direction: 'client-to-server',
    summary: 'Observe health and capability readiness while a view is mounted.',
    payloadSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  'readiness:unsubscribe': {
    direction: 'client-to-server',
    summary: 'Release readiness observation; the last subscriber stops the observer.',
    payloadSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  'code-animation:changed': {
    direction: 'server-to-client',
    summary: 'Invalidate the bounded Code Animation gallery and matching selected job after a durable job change.',
    payloadSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },

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
  'eidoverse-travel:subscribe': {
    direction: 'client-to-server',
    summary: 'Watch guest destinations while an operator travel panel is visible.',
    payloadSchema: { type: 'null' },
  },
  'eidoverse-travel:unsubscribe': {
    direction: 'client-to-server',
    summary: 'Stop watching guest destinations; the last subscriber stops external probes.',
    payloadSchema: { type: 'null' },
  },
  'eidoverse-travel:destinations': {
    direction: 'server-to-client',
    summary: 'Changed guest destination snapshot for subscribed operator panels only.',
    payloadSchema: {
      type: 'object', required: ['destinations'], additionalProperties: false,
      properties: {
        destinations: {
          type: 'array',
          items: {
            type: 'object', required: ['peerId', 'label'], additionalProperties: false,
            properties: { peerId: { type: 'string' }, label: { type: 'string' } },
          },
        },
      },
    },
  },
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
  'sprites:changed': {
    direction: 'server-to-client',
    summary: 'A sprite run, reference manifest or candidate was persisted; reread this record.',
    payloadSchema: { type: 'object', properties: { recordId: { type: 'string' } }, required: ['recordId'], additionalProperties: false },
  },
  'sprites:jobs-changed': {
    direction: 'server-to-client',
    summary: 'A sprite media job changed lifecycle state; reconcile this record and render lane.',
    payloadSchema: {
      type: 'object',
      properties: { recordId: { type: 'string' }, kind: { type: 'string' }, tagKey: { type: 'string' } },
      required: ['recordId', 'kind', 'tagKey'], additionalProperties: false,
    },
  },
  'media-jobs:changed': {
    direction: 'server-to-client',
    summary: 'Invalidate queue snapshots after job, progress, archive or hold changes.',
    payloadSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  'training:dataset:changed': {
    direction: 'server-to-client',
    summary: 'Dataset changes were persisted; reread this dataset.',
    payloadSchema: { type: 'object', properties: { datasetId: { type: 'string' } }, required: ['datasetId'], additionalProperties: false },
  },
  'training:checkpoints:changed': {
    direction: 'server-to-client',
    summary: 'Training checkpoints or samples were persisted; reread this run.',
    payloadSchema: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'], additionalProperties: false },
  },
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
  'image-to-3d:changed': {
    direction: 'server-to-client',
    summary: 'Invalidate one model after a persisted lifecycle change, including progress and deletion.',
    payloadSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } }, additionalProperties: false },
  },
  'threejs-model:changed': {
    direction: 'server-to-client',
    summary: 'Invalidate one model after a persisted lifecycle change, including progress and deletion.',
    payloadSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } }, additionalProperties: false },
  },
  'provider-quota:updated': {
    direction: 'server-to-client',
    summary: 'Invalidate quota cards after a background scrape settles, including failures; no account or quota data.',
    payloadSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
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
