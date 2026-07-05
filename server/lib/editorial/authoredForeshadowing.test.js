import { describe, it, expect } from 'vitest';

import { authoredSetupPayoffSummary, authoredForeshadowingSummary } from './checkInfra.js';

// #2172: the arc-overview-emitted foreshadowing ledger (series.arc.foreshadowing)
// is consumed by the Chekhov check by folding it into the SAME authoredSetups
// block the reader-map hooks/payoffs render into — so the shipped Chekhov prompt
// picks it up through its existing `{{#authoredSetups}}` section with no template
// change. These pins guard that folding contract.
const ledger = [
  { label: 'The locked drawer', plantIssue: 1, reinforceIssues: [3], payoffIssue: 6, note: 'the revolver fires' },
  { label: 'Mara’s limp', plantIssue: 2, payoffIssue: 9 },
];

describe('authoredForeshadowingSummary (#2172)', () => {
  it('returns empty string for a missing/empty ledger', () => {
    expect(authoredForeshadowingSummary(null)).toBe('');
    expect(authoredForeshadowingSummary([])).toBe('');
    expect(authoredForeshadowingSummary('nope')).toBe('');
  });

  it('renders each seed as a plant → reinforce → payoff line', () => {
    const out = authoredForeshadowingSummary(ledger);
    expect(out).toContain('Authored foreshadowing ledger');
    expect(out).toContain('The locked drawer — the revolver fires (plant issue 1 → reinforced issue 3 → payoff issue 6)');
    expect(out).toContain('Mara’s limp (plant issue 2 → payoff issue 9)');
  });

  it('drops entries with no label or note', () => {
    expect(authoredForeshadowingSummary([{ plantIssue: 1, payoffIssue: 5 }])).toBe('');
  });
});

describe('authoredSetupPayoffSummary folds in the foreshadowing ledger (#2172)', () => {
  it('appends the ledger block after the reader-map hooks/payoffs', () => {
    const readerMap = {
      hooks: [{ label: 'Who is the masked figure?', atArcPosition: 1 }],
      payoffs: [{ label: 'The figure is unmasked', atArcPosition: 6 }],
    };
    const out = authoredSetupPayoffSummary(readerMap, ledger);
    expect(out).toContain('Authored hooks');
    expect(out).toContain('Authored payoffs');
    expect(out).toContain('Authored foreshadowing ledger');
    // Ledger block comes last.
    expect(out.indexOf('Authored foreshadowing ledger')).toBeGreaterThan(out.indexOf('Authored hooks'));
  });

  it('renders the ledger even when there is no reader map (ledger-only series)', () => {
    const out = authoredSetupPayoffSummary(null, ledger);
    expect(out).toContain('Authored foreshadowing ledger');
    expect(out).not.toContain('Authored hooks');
  });

  it('is backward-compatible: no ledger arg behaves like before', () => {
    const readerMap = { hooks: [{ label: 'A hook' }], payoffs: [] };
    const out = authoredSetupPayoffSummary(readerMap);
    expect(out).toContain('Authored hooks');
    expect(out).not.toContain('foreshadowing');
  });

  it('returns empty string when nothing is authored on either side', () => {
    expect(authoredSetupPayoffSummary(null, null)).toBe('');
    expect(authoredSetupPayoffSummary({ hooks: [], payoffs: [] }, [])).toBe('');
  });
});
