/**
 * Shrink-only size ratchet for the rendered claim prompts (#16409): the base
 * body from `composeClaimIssuePrompt` and the claim-flow completion section are
 * the two largest fixed costs in every claim run's context, and nothing else
 * stopped them growing. Modeled on the living-docs ratchet in
 * server/test/guards/repo/docs-index.test.js (#16221).
 *
 * A ceiling is the variant's byte size on main when it was recorded. Growth past
 * it fails; a shrink always passes. After a prompt shrinks, lower its entry so
 * the saving cannot be spent again (a ceiling higher than needed is allowed).
 */
import { readdirSync, statSync } from 'node:fs';
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
  'pinned-preflighted': {
    target: 123, preverified: true, nonEpic: true, serverCheckout: true,
    commentsClear: true, linkedWorkClear: true,
    forgeContext: { repo: 'owner/repo', host: 'github.com', me: 'owner' },
  },
};

// Use the content-addressed filename shape without making the size machine-dependent.
const onDemand = async (text) => (await deferClaimSections({ description: text },
  async (name) => `/install/data/cos/slashdo-resolved/${name}-${'a'.repeat(64)}.md`)).description;

const claimIssueVariants = async () => {
  const variants = { 'claim-issue jira': composeClaimIssuePrompt({ forge: 'jira' }) };
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
  'claim-flow completion agent tui provisioned': buildClaimFlowCompletionSection({ agentId: 'agent-0001', isTui: true, sentinelPath: '/tmp/sentinel.md', reviewersCsv: 'claude,codex', serverCheckout: true }),
});

const SIZE_CEILINGS = {
  'claim-issue jira': 18380,
  'claim-issue github unpinned review-then-merge': 49806,
  'claim-issue github unpinned review-then-merge on-demand': 20930,
  'claim-issue github unpinned merge-on-green': 44167,
  'claim-issue github unpinned merge-on-green on-demand': 20327,
  'claim-issue github unpinned leave-open': 44907,
  'claim-issue github unpinned leave-open on-demand': 20625,
  'claim-issue github pinned-epic review-then-merge': 46966,
  'claim-issue github pinned-epic review-then-merge on-demand': 18866,
  'claim-issue github pinned-epic merge-on-green': 41327,
  'claim-issue github pinned-epic merge-on-green on-demand': 18263,
  'claim-issue github pinned-epic leave-open': 42067,
  'claim-issue github pinned-epic leave-open on-demand': 18561,
  'claim-issue github pinned-non-epic review-then-merge': 37468,
  'claim-issue github pinned-non-epic review-then-merge on-demand': 18411,
  'claim-issue github pinned-non-epic merge-on-green': 31829,
  'claim-issue github pinned-non-epic merge-on-green on-demand': 17808,
  'claim-issue github pinned-non-epic leave-open': 32636,
  'claim-issue github pinned-non-epic leave-open on-demand': 18106,
  'claim-issue github pinned-provisioned review-then-merge': 36425,
  'claim-issue github pinned-provisioned review-then-merge on-demand': 17380,
  'claim-issue github pinned-provisioned merge-on-green': 30786,
  'claim-issue github pinned-provisioned merge-on-green on-demand': 16777,
  'claim-issue github pinned-provisioned leave-open': 31605,
  'claim-issue github pinned-provisioned leave-open on-demand': 17075,
  'claim-issue github pinned-preflighted review-then-merge': 27504,
  'claim-issue github pinned-preflighted review-then-merge on-demand': 13423,
  'claim-issue github pinned-preflighted merge-on-green': 21865,
  'claim-issue github pinned-preflighted merge-on-green on-demand': 12820,
  'claim-issue github pinned-preflighted leave-open': 22684,
  'claim-issue github pinned-preflighted leave-open on-demand': 13118,
  'claim-issue gitlab unpinned review-then-merge': 39294,
  'claim-issue gitlab unpinned review-then-merge on-demand': 19509,
  'claim-issue gitlab unpinned merge-on-green': 33605,
  'claim-issue gitlab unpinned merge-on-green on-demand': 18956,
  'claim-issue gitlab unpinned leave-open': 36517,
  'claim-issue gitlab unpinned leave-open on-demand': 19226,
  'claim-issue gitlab pinned-epic review-then-merge': 36710,
  'claim-issue gitlab pinned-epic review-then-merge on-demand': 17674,
  'claim-issue gitlab pinned-epic merge-on-green': 31021,
  'claim-issue gitlab pinned-epic merge-on-green on-demand': 17121,
  'claim-issue gitlab pinned-epic leave-open': 33933,
  'claim-issue gitlab pinned-epic leave-open on-demand': 17391,
  'claim-issue gitlab pinned-non-epic review-then-merge': 31934,
  'claim-issue gitlab pinned-non-epic review-then-merge on-demand': 17295,
  'claim-issue gitlab pinned-non-epic merge-on-green': 26245,
  'claim-issue gitlab pinned-non-epic merge-on-green on-demand': 16742,
  'claim-issue gitlab pinned-non-epic leave-open': 29220,
  'claim-issue gitlab pinned-non-epic leave-open on-demand': 17012,
  'claim-issue gitlab pinned-provisioned review-then-merge': 30759,
  'claim-issue gitlab pinned-provisioned review-then-merge on-demand': 16132,
  'claim-issue gitlab pinned-provisioned merge-on-green': 25070,
  'claim-issue gitlab pinned-provisioned merge-on-green on-demand': 15579,
  'claim-issue gitlab pinned-provisioned leave-open': 28057,
  'claim-issue gitlab pinned-provisioned leave-open on-demand': 15849,
  'claim-issue gitlab pinned-preflighted review-then-merge': 24880,
  'claim-issue gitlab pinned-preflighted review-then-merge on-demand': 12929,
  'claim-issue gitlab pinned-preflighted merge-on-green': 19191,
  'claim-issue gitlab pinned-preflighted merge-on-green on-demand': 12376,
  'claim-issue gitlab pinned-preflighted leave-open': 22178,
  'claim-issue gitlab pinned-preflighted leave-open on-demand': 12646,
  'claim-flow completion default': 2740,
  'claim-flow completion agent review': 7803,
  'claim-flow completion agent merge-on-green': 6451,
  'claim-flow completion agent leave-open': 6058,
  'claim-flow completion agent tui': 11518,
  'claim-flow completion agent tui provisioned': 8580,
};

const SIZES = Object.fromEntries(
  Object.entries({ ...(await claimIssueVariants()), ...completionVariants() }).map(([name, text]) => [name, bytes(text)]),
);

describe('claim prompt size ratchet', () => {
  it('retains the 30% reduction in combined claim catalog source', () => {
    const catalog = new URL('./catalog/', import.meta.url);
    const files = readdirSync(catalog).filter(file => /^claim.*\.js$/.test(file));
    const total = files.reduce((sum, file) => sum + statSync(new URL(file, catalog)).size, 0);
    // Before extraction the three claim definitions occupied 84,123 UTF-8 bytes.
    expect(total).toBeLessThanOrEqual(Math.floor(84_123 * 0.70));
  });

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
