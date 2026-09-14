import { describe, it, expect } from 'vitest';
import { MODEL_SELECTABLE_REVIEWERS } from './reviewerConfig.js';
import {
  REVIEWER_PROVIDER_MATCHERS,
  providersForReviewer,
  reviewerProviderIds,
} from './reviewerProviderMatchers.js';

const cli = (id, command = id) => ({ id, type: 'cli', command });
const tui = (id, command) => ({ id, type: 'tui', command });

describe('reviewer roster coverage', () => {
  it('classifies every reviewer whose model the user can pin', () => {
    // A reviewer that gains model selection with no row here has its pin judged
    // against NO catalog — the audit silently stops covering it, and the picker
    // offers it nothing. Both failures are invisible without this.
    expect(Object.keys(REVIEWER_PROVIDER_MATCHERS).sort())
      .toEqual([...MODEL_SELECTABLE_REVIEWERS].sort());
  });
});

describe('providersForReviewer', () => {
  it('returns every record fronting the binary, in matcher order not catalog order', () => {
    // The TUI record is listed FIRST in the catalog; preference order still puts
    // the headless CLI at [0], because that is the one a reviewer spawns.
    const records = [cli('claude-code-tui'), cli('claude-code'), cli('codex')];
    expect(providersForReviewer('claude', records).map((p) => p.id))
      .toEqual(['claude-code', 'claude-code-tui']);
  });

  it('de-dupes a record two matchers both claim', () => {
    // `grok-cli` satisfies the id matcher AND `isGrokBuildCli`.
    const records = [cli('grok-cli', 'grok'), tui('grok-tui', 'grok')];
    expect(providersForReviewer('grok', records).map((p) => p.id))
      .toEqual(['grok-cli', 'grok-tui']);
  });

  it('recognizes a path-configured binary the shipped ids do not name', () => {
    const records = [cli('my-grok', '/opt/homebrew/bin/grok')];
    expect(providersForReviewer('grok', records).map((p) => p.id)).toEqual(['my-grok']);
  });

  it('leaves a plain Grok API record out — it launches no binary', () => {
    expect(providersForReviewer('grok', [{ id: 'grok', type: 'api', command: '' }])).toEqual([]);
  });

  it('answers empty for an unknown reviewer and for a missing catalog', () => {
    // Both must read as "nothing is KNOWN" at every caller, never as
    // "nothing is offered" — the audit turns the second into a false retirement.
    expect(providersForReviewer('copilot', [cli('codex')])).toEqual([]);
    expect(providersForReviewer('codex', null)).toEqual([]);
  });
});

describe('reviewerProviderIds', () => {
  it('drops a record carrying no usable id', () => {
    expect(reviewerProviderIds('codex', [{ type: 'cli', command: 'codex' }, cli('codex')]))
      .toEqual(['codex']);
  });
});
