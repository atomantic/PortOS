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
import { PATHS } from '../../lib/paths.js';
import { composeClaimIssuePrompt } from './prompts.js';
import { buildClaimFlowCompletionSection } from '../promptSections/completion.js';
import { deferClaimSections } from '../promptSections/claimOnDemand.js';

// Prompts name repo files by absolute path (PATHS.root), so the checkout's location would change
// the size: a CoS claim worktree's longer path failed every completion variant. Measure with the
// root replaced by a fixed placeholder so a ceiling tracks only the prompt's own text.
const bytes = (text) => Buffer.byteLength(text.replaceAll(PATHS.root, '<repo-root>'), 'utf8');

const SHAPES = {
  unpinned: {},
  'pinned-epic': { target: 123 },
  'pinned-non-epic': { target: 123, preverified: true, nonEpic: true },
  'pinned-provisioned': { target: 123, preverified: true, nonEpic: true, serverCheckout: true },
};

// Use the content-addressed filename shape without making the size machine-dependent.
const onDemand = async (text) => (await deferClaimSections({ description: text },
  async (name) => `/install/data/cos/slashdo-resolved/${name}-${'a'.repeat(64)}.md`)).description;

const claimIssueVariants = async () => {
  const variants = {};
  for (const forge of ['github', 'gitlab']) {
    for (const [shape, options] of Object.entries(SHAPES)) {
      for (const prCompletion of ['review-then-merge', 'merge-on-green', 'leave-open']) {
        const name = `claim-issue ${forge} ${shape} ${prCompletion}`;
        variants[name] = composeClaimIssuePrompt({ forge, prCompletion, ...options });
        variants[`${name} on-demand`] = await onDemand(variants[name]);
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
  'claim-issue github unpinned review-then-merge': 55520,
  'claim-issue github unpinned review-then-merge on-demand': 39670,
  'claim-issue github unpinned merge-on-green': 48312,
  'claim-issue github unpinned merge-on-green on-demand': 32462,
  'claim-issue github unpinned leave-open': 50621,
  'claim-issue github unpinned leave-open on-demand': 34841,
  'claim-issue github pinned-epic review-then-merge': 50718,
  'claim-issue github pinned-epic review-then-merge on-demand': 34895,
  'claim-issue github pinned-epic merge-on-green': 43510,
  'claim-issue github pinned-epic merge-on-green on-demand': 27687,
  'claim-issue github pinned-epic leave-open': 45819,
  'claim-issue github pinned-epic leave-open on-demand': 30066,
  'claim-issue github pinned-non-epic review-then-merge': 41220,
  'claim-issue github pinned-non-epic review-then-merge on-demand': 34440,
  'claim-issue github pinned-non-epic merge-on-green': 34012,
  'claim-issue github pinned-non-epic merge-on-green on-demand': 27232,
  'claim-issue github pinned-non-epic leave-open': 36388,
  'claim-issue github pinned-non-epic leave-open on-demand': 29611,
  'claim-issue github pinned-provisioned review-then-merge': 40887,
  'claim-issue github pinned-provisioned review-then-merge on-demand': 34107,
  'claim-issue github pinned-provisioned merge-on-green': 33679,
  'claim-issue github pinned-provisioned merge-on-green on-demand': 26899,
  'claim-issue github pinned-provisioned leave-open': 36055,
  'claim-issue github pinned-provisioned leave-open on-demand': 29278,
  'claim-issue gitlab unpinned review-then-merge': 43528,
  'claim-issue gitlab unpinned review-then-merge on-demand': 33755,
  'claim-issue gitlab unpinned merge-on-green': 36261,
  'claim-issue gitlab unpinned merge-on-green on-demand': 26488,
  'claim-issue gitlab unpinned leave-open': 40751,
  'claim-issue gitlab unpinned leave-open on-demand': 31044,
  'claim-issue gitlab pinned-epic review-then-merge': 40108,
  'claim-issue gitlab pinned-epic review-then-merge on-demand': 30335,
  'claim-issue gitlab pinned-epic merge-on-green': 32841,
  'claim-issue gitlab pinned-epic merge-on-green on-demand': 23068,
  'claim-issue gitlab pinned-epic leave-open': 37331,
  'claim-issue gitlab pinned-epic leave-open on-demand': 27624,
  'claim-issue gitlab pinned-non-epic review-then-merge': 35332,
  'claim-issue gitlab pinned-non-epic review-then-merge on-demand': 29956,
  'claim-issue gitlab pinned-non-epic merge-on-green': 28065,
  'claim-issue gitlab pinned-non-epic merge-on-green on-demand': 22689,
  'claim-issue gitlab pinned-non-epic leave-open': 32618,
  'claim-issue gitlab pinned-non-epic leave-open on-demand': 27245,
  'claim-issue gitlab pinned-provisioned review-then-merge': 35136,
  'claim-issue gitlab pinned-provisioned review-then-merge on-demand': 29760,
  'claim-issue gitlab pinned-provisioned merge-on-green': 27869,
  'claim-issue gitlab pinned-provisioned merge-on-green on-demand': 22493,
  'claim-issue gitlab pinned-provisioned leave-open': 32422,
  'claim-issue gitlab pinned-provisioned leave-open on-demand': 27049,
  'claim-flow completion default': 2749,
  'claim-flow completion agent review': 8480,
  'claim-flow completion agent merge-on-green': 6954,
  'claim-flow completion agent leave-open': 6685,
  'claim-flow completion agent tui': 12328,
};

const SIZES = Object.fromEntries(
  Object.entries({ ...(await claimIssueVariants()), ...completionVariants() }).map(([name, text]) => [name, bytes(text)]),
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
