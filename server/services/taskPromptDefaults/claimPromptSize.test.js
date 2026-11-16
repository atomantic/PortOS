/**
 * Shrink-only size ratchet for the rendered claim prompts (#16409): the base
 * body from `composeClaimIssuePrompt` and the claim-flow completion section are
 * the two largest fixed costs in every claim run's context, and nothing else
 * stopped them growing. Modeled on the living-docs ratchet in
 * docs/docs-index.test.js (#16221).
 *
 * A ceiling is the variant's byte size on main when it was recorded. Growth past
 * it fails; a shrink always passes. After a prompt shrinks, lower its entry so
 * the saving cannot be spent again (a ceiling higher than needed is allowed).
 */
import { describe, expect, it } from 'vitest';
import { composeClaimIssuePrompt } from './prompts.js';
import { buildClaimFlowCompletionSection } from '../promptSections/completion.js';

const bytes = (text) => Buffer.byteLength(text, 'utf8');

const SHAPES = {
  unpinned: {},
  'pinned-epic': { target: 123 },
  'pinned-non-epic': { target: 123, preverified: true, nonEpic: true },
  'pinned-provisioned': { target: 123, preverified: true, nonEpic: true, serverCheckout: true },
};

const claimIssueVariants = () => {
  const variants = {};
  for (const forge of ['github', 'gitlab']) {
    for (const [shape, options] of Object.entries(SHAPES)) {
      for (const prCompletion of ['review-then-merge', 'merge-on-green', 'leave-open']) {
        variants[`claim-issue ${forge} ${shape} ${prCompletion}`] = composeClaimIssuePrompt({ forge, prCompletion, ...options });
      }
    }
  }
  return variants;
};

const completionVariants = () => ({
  'claim-flow completion default': buildClaimFlowCompletionSection({}),
  'claim-flow completion agent review': buildClaimFlowCompletionSection({ agentId: 'agent-0001', reviewersCsv: 'claude,codex' }),
  'claim-flow completion agent merge-on-green': buildClaimFlowCompletionSection({ agentId: 'agent-0001', rawPrCompletion: 'merge-on-green' }),
  'claim-flow completion agent leave-open': buildClaimFlowCompletionSection({ agentId: 'agent-0001', prStaysOpen: true, rawPrCompletion: 'leave-open', reviewersCsv: 'claude' }),
  'claim-flow completion agent tui': buildClaimFlowCompletionSection({ agentId: 'agent-0001', isTui: true, sentinelPath: '/tmp/sentinel.md', reviewersCsv: 'claude,codex' }),
});

const SIZE_CEILINGS = {
  'claim-issue github unpinned review-then-merge': 59167,
  'claim-issue github unpinned merge-on-green': 50791,
  'claim-issue github unpinned leave-open': 53833,
  'claim-issue github pinned-epic review-then-merge': 54321,
  'claim-issue github pinned-epic merge-on-green': 45945,
  'claim-issue github pinned-epic leave-open': 48987,
  'claim-issue github pinned-non-epic review-then-merge': 44816,
  'claim-issue github pinned-non-epic merge-on-green': 36440,
  'claim-issue github pinned-non-epic leave-open': 39549,
  'claim-issue github pinned-provisioned review-then-merge': 44489,
  'claim-issue github pinned-provisioned merge-on-green': 36113,
  'claim-issue github pinned-provisioned leave-open': 39222,
  'claim-issue gitlab unpinned review-then-merge': 46740,
  'claim-issue gitlab unpinned merge-on-green': 38212,
  'claim-issue gitlab unpinned leave-open': 43526,
  'claim-issue gitlab pinned-epic review-then-merge': 43276,
  'claim-issue gitlab pinned-epic merge-on-green': 34748,
  'claim-issue gitlab pinned-epic leave-open': 40062,
  'claim-issue gitlab pinned-non-epic review-then-merge': 38493,
  'claim-issue gitlab pinned-non-epic merge-on-green': 29965,
  'claim-issue gitlab pinned-non-epic leave-open': 35342,
  'claim-issue gitlab pinned-provisioned review-then-merge': 38303,
  'claim-issue gitlab pinned-provisioned merge-on-green': 29775,
  'claim-issue gitlab pinned-provisioned leave-open': 35152,
  'claim-flow completion default': 3379,
  'claim-flow completion agent review': 9110,
  'claim-flow completion agent merge-on-green': 7005,
  'claim-flow completion agent leave-open': 7315,
  'claim-flow completion agent tui': 12958,
};

const SIZES = Object.fromEntries(
  Object.entries({ ...claimIssueVariants(), ...completionVariants() }).map(([name, text]) => [name, bytes(text)]),
);

describe('claim prompt size ratchet', () => {
  it('records a ceiling for exactly the variants it renders', () => {
    expect(Object.keys(SIZE_CEILINGS).sort()).toEqual(Object.keys(SIZES).sort());
  });

  it.each(Object.keys(SIZES))('keeps "%s" within its byte ceiling', (name) => {
    const size = SIZES[name];
    const ceiling = SIZE_CEILINGS[name];
    expect(
      size,
      `${name} grew to ${size} B, over its ${ceiling} B ceiling; move the new text into a shared part or drop other text instead of raising the ceiling`,
    ).toBeLessThanOrEqual(ceiling);
  });
});
