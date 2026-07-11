import { describe, it, expect } from 'vitest';
import { formatLiReason, liReasonTone, LI_NEUTRAL_REASONS } from './layeredIntelligenceReasons';

describe('formatLiReason', () => {
  it('glosses a plain reason token', () => {
    expect(formatLiReason({ action: 'no-op', reason: 'unparseable-response' })).toMatch(/no usable JSON/i);
    expect(formatLiReason({ action: 'no-op', reason: 'no-provider' })).toMatch(/no AI provider/i);
  });

  it('glosses an api-only provider pinned to the reasoning agent', () => {
    expect(formatLiReason({ action: 'skipped', reason: 'provider-not-agent-capable' }))
      .toMatch(/API-only model with no coding harness — pick a CLI\/TUI provider/i);
  });

  it('strips the llm-error prefix into a provider-error sentence', () => {
    expect(formatLiReason({ action: 'no-op', reason: 'llm-error: provider timeout' }))
      .toBe('the AI provider errored — provider timeout');
  });

  it('renders a park from either the reason token or the parked action, with an optional count', () => {
    expect(formatLiReason({ action: 'parked', reason: 'blocking-open', blocking: 3 })).toMatch(/paused on a blocking issue \(3 open\)/);
    // The durable status line has no persisted count → no parenthetical.
    expect(formatLiReason({ reason: 'blocking-open' })).toBe('paused on a blocking issue — resolve or unblock it to resume');
  });

  it('explains an in-flight run', () => {
    expect(formatLiReason({ action: 'in-flight' })).toMatch(/still in progress/i);
  });

  it('falls back to the raw token then a generic phrase', () => {
    expect(formatLiReason({ reason: 'some-future-reason' })).toBe('some-future-reason');
    expect(formatLiReason({})).toBe('it produced no proposal');
  });
});

describe('liReasonTone', () => {
  it('is error for a provider throw', () => {
    expect(liReasonTone('llm-error: boom')).toBe('error');
  });
  it('is neutral for a nothing-new run', () => {
    for (const r of LI_NEUTRAL_REASONS) expect(liReasonTone(r)).toBe('neutral');
  });
  it('is warn for a config/read failure', () => {
    expect(liReasonTone('unparseable-response')).toBe('warn');
    expect(liReasonTone('jira-not-configured')).toBe('warn');
    expect(liReasonTone(null)).toBe('warn');
  });
});
