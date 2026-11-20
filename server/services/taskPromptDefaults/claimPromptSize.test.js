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
});

const SIZE_CEILINGS = {
  'claim-issue jira': 18408,
  'claim-issue github unpinned review-then-merge': 50877,
  'claim-issue github unpinned review-then-merge on-demand': 35027,
  'claim-issue github unpinned merge-on-green': 45238,
  'claim-issue github unpinned merge-on-green on-demand': 29388,
  'claim-issue github unpinned leave-open': 45978,
  'claim-issue github unpinned leave-open on-demand': 30198,
  'claim-issue github pinned-epic review-then-merge': 47246,
  'claim-issue github pinned-epic review-then-merge on-demand': 31423,
  'claim-issue github pinned-epic merge-on-green': 41607,
  'claim-issue github pinned-epic merge-on-green on-demand': 25784,
  'claim-issue github pinned-epic leave-open': 42347,
  'claim-issue github pinned-epic leave-open on-demand': 26594,
  'claim-issue github pinned-non-epic review-then-merge': 37748,
  'claim-issue github pinned-non-epic review-then-merge on-demand': 30968,
  'claim-issue github pinned-non-epic merge-on-green': 32109,
  'claim-issue github pinned-non-epic merge-on-green on-demand': 25329,
  'claim-issue github pinned-non-epic leave-open': 32916,
  'claim-issue github pinned-non-epic leave-open on-demand': 26139,
  'claim-issue github pinned-provisioned review-then-merge': 38600,
  'claim-issue github pinned-provisioned review-then-merge on-demand': 31820,
  'claim-issue github pinned-provisioned merge-on-green': 32961,
  'claim-issue github pinned-provisioned merge-on-green on-demand': 26181,
  'claim-issue github pinned-provisioned leave-open': 33768,
  'claim-issue github pinned-provisioned leave-open on-demand': 26991,
  'claim-issue gitlab unpinned review-then-merge': 39575,
  'claim-issue gitlab unpinned review-then-merge on-demand': 29802,
  'claim-issue gitlab unpinned merge-on-green': 33886,
  'claim-issue gitlab unpinned merge-on-green on-demand': 24113,
  'claim-issue gitlab unpinned leave-open': 36798,
  'claim-issue gitlab unpinned leave-open on-demand': 27091,
  'claim-issue gitlab pinned-epic review-then-merge': 36990,
  'claim-issue gitlab pinned-epic review-then-merge on-demand': 27217,
  'claim-issue gitlab pinned-epic merge-on-green': 31301,
  'claim-issue gitlab pinned-epic merge-on-green on-demand': 21528,
  'claim-issue gitlab pinned-epic leave-open': 34213,
  'claim-issue gitlab pinned-epic leave-open on-demand': 24506,
  'claim-issue gitlab pinned-non-epic review-then-merge': 32214,
  'claim-issue gitlab pinned-non-epic review-then-merge on-demand': 26838,
  'claim-issue gitlab pinned-non-epic merge-on-green': 26525,
  'claim-issue gitlab pinned-non-epic merge-on-green on-demand': 21149,
  'claim-issue gitlab pinned-non-epic leave-open': 29500,
  'claim-issue gitlab pinned-non-epic leave-open on-demand': 24127,
  'claim-issue gitlab pinned-provisioned review-then-merge': 32925,
  'claim-issue gitlab pinned-provisioned review-then-merge on-demand': 27549,
  'claim-issue gitlab pinned-provisioned merge-on-green': 27236,
  'claim-issue gitlab pinned-provisioned merge-on-green on-demand': 21860,
  'claim-issue gitlab pinned-provisioned leave-open': 30211,
  'claim-issue gitlab pinned-provisioned leave-open on-demand': 24838,
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
