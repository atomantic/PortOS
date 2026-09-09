import { describe, expect, it } from 'vitest';
import {
  QUOTA_BURN_PROVENANCE_FIELDS,
  hasQuotaBurnProvenance,
  normalizeQuotaBurnProvenance,
  onDemandRequestMetadata,
  quotaBurnAgentMetadata,
  quotaBurnProvenance,
  quotaBurnTaskMetadata,
} from './quotaBurnOrigin.js';

const provenance = (overrides = {}) => ({ family: 'grok', stepId: 'step-1', ...overrides });

describe('normalizeQuotaBurnProvenance', () => {
  it('keeps the family, step, limiting reset, the three override pins and the run params', () => {
    // The params ride here because they have to reach the PROMPT: the on-demand
    // engines hand them to the generator as `runOverrides`, which is what lets a
    // migrated issues-only burn pin `fileIssues: true` explicitly (#6381).
    expect(normalizeQuotaBurnProvenance(provenance({
      limitingResetAt: 1700000000000,
      overrides: { providerId: 'grok-tui', model: 'm', effort: 'high', params: { fileIssues: true, maxEntries: 5 } },
    }))).toEqual({
      family: 'grok',
      stepId: 'step-1',
      limitingResetAt: 1700000000000,
      overrides: { providerId: 'grok-tui', model: 'm', effort: 'high', params: { fileIssues: true, maxEntries: 5 } },
    });
  });

  it('carries a manual maintenance run id through, and omits it on an automatic burn', () => {
    // The only hop where the request's run id survives into task metadata — the
    // engines spread the normalized block. Dropping it would put the burn plan
    // back to walking on a manual run's completions with the suite still green.
    expect(normalizeQuotaBurnProvenance(provenance({ maintenanceRunId: 'maint-1' })).maintenanceRunId).toBe('maint-1');
    expect(normalizeQuotaBurnProvenance(provenance())).not.toHaveProperty('maintenanceRunId');
    expect(onDemandRequestMetadata({ id: 'demand-9', origin: 'quota-burn', burn: provenance({ maintenanceRunId: 'maint-1' }) }))
      .toMatchObject({ quotaBurnFamily: 'grok', quotaBurnMaintenanceRunId: 'maint-1' });
  });

  it('drops a non-scalar run param rather than carrying a blob into task metadata', () => {
    const block = normalizeQuotaBurnProvenance(provenance({ overrides: { params: { fileIssues: true, nested: { a: 1 } } } }));
    expect(block.overrides.params).toEqual({ fileIssues: true });
  });

  it('rejects a block that cannot attribute the burn', () => {
    // Family AND step are both required: without the family nothing can credit a
    // provider refusal, and without the step the run log cannot say what ran.
    expect(normalizeQuotaBurnProvenance({ stepId: 'step-1' })).toBeNull();
    expect(normalizeQuotaBurnProvenance({ family: 'grok' })).toBeNull();
    expect(normalizeQuotaBurnProvenance(null)).toBeNull();
    expect(normalizeQuotaBurnProvenance('grok')).toBeNull();
  });

  it('nulls an unreadable limiting reset rather than passing NaN downstream', () => {
    expect(normalizeQuotaBurnProvenance(provenance({ limitingResetAt: 'soon' })).limitingResetAt).toBeNull();
    expect(normalizeQuotaBurnProvenance(provenance()).limitingResetAt).toBeNull();
  });
});

describe('onDemandRequestMetadata', () => {
  it('records that the task came from the request queue, and who asked', () => {
    expect(onDemandRequestMetadata({ id: 'demand-1', origin: 'user' }))
      .toEqual({ onDemand: true, onDemandOrigin: 'user' });
    expect(onDemandRequestMetadata({ id: 'demand-2', origin: 'refill' }))
      .toEqual({ onDemand: true, onDemandOrigin: 'refill' });
  });

  it('leaves the origin null when the request predates the field', () => {
    // Readers treat a null origin as a human Run — the safe default for a queue
    // that is otherwise human-filled.
    expect(onDemandRequestMetadata({ id: 'demand-3' }))
      .toEqual({ onDemand: true, onDemandOrigin: null });
  });

  it('stamps the burn provenance and request identity a burn task must carry', () => {
    expect(onDemandRequestMetadata({
      id: 'demand-7',
      origin: 'quota-burn',
      burn: provenance({ limitingResetAt: 42, overrides: { providerId: 'grok-tui' } }),
    })).toEqual({
      onDemand: true,
      onDemandOrigin: 'quota-burn',
      quotaBurnFamily: 'grok',
      quotaBurnLimitingResetAt: 42,
      quotaBurnStepId: 'step-1',
      quotaBurnRequestId: 'demand-7',
      provider: 'grok-tui',
    });
  });

  it('omits an absent limiting reset instead of writing null onto the task', () => {
    // `cosTaskStore` only persists a FINITE `quotaBurnLimitingResetAt`; emitting
    // an explicit null here would make the raw-task path disagree with it.
    expect(onDemandRequestMetadata({ id: 'demand-7', origin: 'quota-burn', burn: provenance() }))
      .not.toHaveProperty('quotaBurnLimitingResetAt');
  });

  it('adds no burn keys for a request whose provenance cannot be attributed', () => {
    expect(onDemandRequestMetadata({ id: 'demand-8', origin: 'quota-burn', burn: { family: 'grok' } }))
      .toEqual({ onDemand: true, onDemandOrigin: 'quota-burn' });
  });

  it('adds no burn keys to a request that is not a burn, however well-formed its block', () => {
    // `triggerOnDemandTask` refuses to persist a `burn` block on any other
    // origin, so the two can only disagree in a hand-edited schedule — where
    // stamping would make a human Run read as cooldown-exempt and credit its
    // refusal to a family that never dispatched it.
    expect(onDemandRequestMetadata({ id: 'demand-9', origin: 'user', burn: provenance() }))
      .toEqual({ onDemand: true, onDemandOrigin: 'user' });
  });
});

describe('the quota-burn provenance block', () => {
  it('reads a task written by the PREVIOUS release, whose keys are flat markdown strings', () => {
    // The compatibility case the whole block exists to survive: a COS-TASKS.md
    // round-trip hands every scalar back as a string, and a task queued (or
    // back-filled by migration 225) before this refactor carries nothing but the
    // flat keys. It must still read as burn-provenanced.
    const legacy = { quotaBurnFamily: 'agy', quotaBurnLimitingResetAt: '1700000000000', quotaBurnStepId: 'step-9' };
    expect(quotaBurnProvenance(legacy))
      .toEqual({ family: 'agy', limitingResetAt: 1700000000000, stepId: 'step-9' });
    expect(hasQuotaBurnProvenance(legacy)).toBe(true);
    expect(hasQuotaBurnProvenance({ app: 'example-app' })).toBe(false);
  });

  it('accepts provenance handed over as one block, and prefers it per field over a flat key', () => {
    expect(quotaBurnProvenance({ quotaBurn: { family: 'grok', stepId: 'step-1' }, quotaBurnRequestId: 'demand-3' }))
      .toEqual({ family: 'grok', stepId: 'step-1', requestId: 'demand-3' });
  });

  it('leaves a field the task never carried ABSENT rather than null', () => {
    // `quotaBurnRequestId` is the load-bearing one: the synchronous custom-job
    // lane has no request to name, and a null (or synthesized) id would make a
    // join over it silently wrong.
    const metadata = quotaBurnTaskMetadata(quotaBurnProvenance({ quotaBurnFamily: 'grok', quotaBurnStepId: 'step-1' }));
    expect(metadata).toEqual({ quotaBurnFamily: 'grok', quotaBurnStepId: 'step-1' });
    expect(metadata).not.toHaveProperty('quotaBurnRequestId');
    expect(quotaBurnTaskMetadata({ family: 'grok', limitingResetAt: null, requestId: '' }))
      .toEqual({ quotaBurnFamily: 'grok' });
  });

  it('projects EVERY persisted provenance field onto the agent', () => {
    // The regression this uniquely catches: a field that reaches disk but never
    // reaches the agent record is invisible — `quotaBurnStepId` was persisted
    // for a release without the runner's completion continuation or the denial
    // ledger being able to read it. Driving both sides off the one table means a
    // new row cannot be half-applied, and this asserts the table IS both sides.
    const persisted = quotaBurnTaskMetadata({
      family: 'grok', limitingResetAt: 1700000000000, stepId: 'step-1', requestId: 'demand-7', maintenanceRunId: 'maint-1',
    });
    const projected = quotaBurnAgentMetadata(persisted);
    for (const { taskKey, agentKey } of QUOTA_BURN_PROVENANCE_FIELDS) {
      expect(persisted).toHaveProperty(taskKey);
      expect(projected[agentKey]).toBe(persisted[taskKey]);
    }
    expect(Object.keys(projected)).toHaveLength(Object.keys(persisted).length);
  });

  it('projects a field the task never carried as null, and coerces a round-tripped reset', () => {
    // `quotaBurnDenials.js` reads `taskQuotaBurnLimitingResetAt` off the agent to
    // decide how long a refused family stays blocked, and the value may have come
    // back through markdown as a string.
    expect(quotaBurnAgentMetadata({ quotaBurnFamily: 'grok', quotaBurnLimitingResetAt: '1700000000000' })).toEqual({
      taskQuotaBurnFamily: 'grok',
      taskQuotaBurnLimitingResetAt: 1700000000000,
      taskQuotaBurnStepId: null,
      taskQuotaBurnRequestId: null,
      taskQuotaBurnMaintenanceRunId: null,
    });
    expect(quotaBurnAgentMetadata(undefined).taskQuotaBurnFamily).toBeNull();
  });
});
