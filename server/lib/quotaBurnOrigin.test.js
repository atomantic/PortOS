import { describe, expect, it } from 'vitest';
import { normalizeQuotaBurnProvenance, onDemandRequestMetadata } from './quotaBurnOrigin.js';

const provenance = (overrides = {}) => ({ family: 'grok', stepId: 'step-1', ...overrides });

describe('normalizeQuotaBurnProvenance', () => {
  it('keeps the family, step, limiting reset and the three override pins', () => {
    expect(normalizeQuotaBurnProvenance(provenance({
      limitingResetAt: 1700000000000,
      overrides: { providerId: 'grok-tui', model: 'm', effort: 'high' },
    }))).toEqual({
      family: 'grok',
      stepId: 'step-1',
      limitingResetAt: 1700000000000,
      overrides: { providerId: 'grok-tui', model: 'm', effort: 'high' },
    });
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
});
