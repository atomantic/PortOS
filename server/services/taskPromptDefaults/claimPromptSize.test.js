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
  'claim-issue jira': 18408,
  'claim-issue github unpinned review-then-merge': 50805,
  'claim-issue github unpinned review-then-merge on-demand': 27594,
  'claim-issue github unpinned merge-on-green': 45166,
  'claim-issue github unpinned merge-on-green on-demand': 24865,
  'claim-issue github unpinned leave-open': 45906,
  'claim-issue github unpinned leave-open on-demand': 27216,
  'claim-issue github pinned-epic review-then-merge': 47175,
  'claim-issue github pinned-epic review-then-merge on-demand': 23991,
  'claim-issue github pinned-epic merge-on-green': 41536,
  'claim-issue github pinned-epic merge-on-green on-demand': 21262,
  'claim-issue github pinned-epic leave-open': 42276,
  'claim-issue github pinned-epic leave-open on-demand': 23613,
  'claim-issue github pinned-non-epic review-then-merge': 37677,
  'claim-issue github pinned-non-epic review-then-merge on-demand': 23536,
  'claim-issue github pinned-non-epic merge-on-green': 32038,
  'claim-issue github pinned-non-epic merge-on-green on-demand': 20807,
  'claim-issue github pinned-non-epic leave-open': 32845,
  'claim-issue github pinned-non-epic leave-open on-demand': 23158,
  'claim-issue github pinned-provisioned review-then-merge': 36577,
  'claim-issue github pinned-provisioned review-then-merge on-demand': 22448,
  'claim-issue github pinned-provisioned merge-on-green': 30938,
  'claim-issue github pinned-provisioned merge-on-green on-demand': 19719,
  'claim-issue github pinned-provisioned leave-open': 31757,
  'claim-issue github pinned-provisioned leave-open on-demand': 22070,
  'claim-issue github pinned-preflighted review-then-merge': 27700,
  'claim-issue github pinned-preflighted review-then-merge on-demand': 16700,
  'claim-issue github pinned-preflighted merge-on-green': 22100,
  'claim-issue github pinned-preflighted merge-on-green on-demand': 14000,
  'claim-issue github pinned-preflighted leave-open': 22900,
  'claim-issue github pinned-preflighted leave-open on-demand': 16300,
  'claim-issue gitlab unpinned review-then-merge': 39503,
  'claim-issue gitlab unpinned review-then-merge on-demand': 24452,
  'claim-issue gitlab unpinned merge-on-green': 33814,
  'claim-issue gitlab unpinned merge-on-green on-demand': 21669,
  'claim-issue gitlab unpinned leave-open': 36726,
  'claim-issue gitlab unpinned leave-open on-demand': 24113,
  'claim-issue gitlab pinned-epic review-then-merge': 36919,
  'claim-issue gitlab pinned-epic review-then-merge on-demand': 21868,
  'claim-issue gitlab pinned-epic merge-on-green': 31230,
  'claim-issue gitlab pinned-epic merge-on-green on-demand': 19085,
  'claim-issue gitlab pinned-epic leave-open': 34142,
  'claim-issue gitlab pinned-epic leave-open on-demand': 21529,
  'claim-issue gitlab pinned-non-epic review-then-merge': 32143,
  'claim-issue gitlab pinned-non-epic review-then-merge on-demand': 21489,
  'claim-issue gitlab pinned-non-epic merge-on-green': 26454,
  'claim-issue gitlab pinned-non-epic merge-on-green on-demand': 18706,
  'claim-issue gitlab pinned-non-epic leave-open': 29429,
  'claim-issue gitlab pinned-non-epic leave-open on-demand': 21150,
  'claim-issue gitlab pinned-provisioned review-then-merge': 30911,
  'claim-issue gitlab pinned-provisioned review-then-merge on-demand': 20269,
  'claim-issue gitlab pinned-provisioned merge-on-green': 25222,
  'claim-issue gitlab pinned-provisioned merge-on-green on-demand': 17486,
  'claim-issue gitlab pinned-provisioned leave-open': 28209,
  'claim-issue gitlab pinned-provisioned leave-open on-demand': 19930,
  'claim-issue gitlab pinned-preflighted review-then-merge': 25600,
  'claim-issue gitlab pinned-preflighted review-then-merge on-demand': 16800,
  'claim-issue gitlab pinned-preflighted merge-on-green': 20000,
  'claim-issue gitlab pinned-preflighted merge-on-green on-demand': 14000,
  'claim-issue gitlab pinned-preflighted leave-open': 22900,
  'claim-issue gitlab pinned-preflighted leave-open on-demand': 16500,
  'claim-flow completion default': 2749,
  'claim-flow completion agent review': 8480,
  'claim-flow completion agent merge-on-green': 6954,
  'claim-flow completion agent leave-open': 6685,
  'claim-flow completion agent tui': 12328,
  'claim-flow completion agent tui provisioned': 9000,
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
