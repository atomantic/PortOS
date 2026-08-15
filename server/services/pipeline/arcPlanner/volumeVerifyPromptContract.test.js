/**
 * Contract between `pipeline-volume-verify.md` and the context
 * `buildVolumeVerifyContext` hands it — the volume-scope sibling of
 * `verifyPromptContract.test.js`.
 *
 * Same failure mode, same stakes: the prompt's checklist and the rendered
 * context are two independent lists that must agree, with nothing but this file
 * enforcing it. The volume verifier feeds the same revert-on-any-blocker gate as
 * the arc verifier, so a check reading a field the context never renders emits a
 * finding no resolver can close, and the gate stalls forever on a volume with
 * nothing wrong with it. Two instances of that class already shipped against the
 * arc verifier (an `arcRole` check the leaf never rendered; a world-canon check
 * reading `worldCanonText` while the canon lived in `worldCategoriesText`).
 *
 * Both halves of the contract are covered: the record fields the checklist cites
 * in backticks, and the `{{volume.*}}` fields the prompt interpolates.
 */

import { describe, it, expect } from 'vitest';

import { renderVolumeIssue, renderVolumeFields } from './context.js';
import { readShippedPrompt, backtickedTokens, namespacedVars } from './promptContractHelpers.js';

const PROMPT = 'pipeline-volume-verify.md';

// Backticked tokens that are deliberately NOT record fields. Anything backticked
// in the prompt that is not here must be renderable — that is the whole point of
// the guard, so extend this list only for genuinely non-field vocabulary.
const NON_FIELD_TOKENS = new Set([
  // Output-contract vocabulary.
  'issues', 'severity', 'location', 'high', 'medium', 'low',
  // `location` VALUE forms (`episode:3`, `episode:2-3`, bare `volume`), not
  // field names.
  'episode', 'volume',
  // The ordinal placeholder in the `episode:<n>-<n+1>` boundary form.
  'n',
]);

// The prompt scores an issue at whichever depth it has, so BOTH branches of the
// leaf are legitimately citable: `beats` on an LLM-expanded issue, `synopsis` on
// an un-expanded one.
const issueLeafFields = () => new Set([
  ...Object.keys(renderVolumeIssue({ stages: { idea: { output: 'beat sheet' } } })),
  ...Object.keys(renderVolumeIssue({ stages: { idea: { input: 'seed synopsis' } } })),
]);

const renderableFields = () => new Set([
  ...issueLeafFields(),
  ...Object.keys(renderVolumeFields({})),
]);

// Citations the checklist makes in a SPECIFIC scope. The union assertion below
// only proves a cited field is rendered somewhere, which is blind to the case
// codex flagged: `synopsis` exists on both renderers, so either side could drop
// it and the other would mask the loss. These pin the owner. New tokens still
// get caught by the union check — this table only has to carry the names the
// generic scan cannot attribute on its own.
const SCOPED_CITATIONS = [
  // "Each entry has either `beats` … OR just `synopsis`" — the issue leaf.
  ['beats', 'issue leaf', issueLeafFields],
  ['synopsis', 'issue leaf', issueLeafFields],
  ['arcPosition', 'issue leaf', issueLeafFields],
  // Checks #1/#4/#5 read these off the volume node.
  ['logline', 'volume node', () => new Set(Object.keys(renderVolumeFields({})))],
  ['synopsis', 'volume node', () => new Set(Object.keys(renderVolumeFields({})))],
  ['endingHook', 'volume node', () => new Set(Object.keys(renderVolumeFields({})))],
];

const unrenderableIn = (markdown, renderable) => [...backtickedTokens(markdown)]
  .filter((token) => !NON_FIELD_TOKENS.has(token) && !renderable.has(token));

describe('pipeline-volume-verify prompt ↔ buildVolumeVerifyContext contract', () => {
  it('renders every record field the shipped checklist cites', async () => {
    const markdown = await readShippedPrompt(PROMPT);
    expect(unrenderableIn(markdown, renderableFields())).toEqual([]);
  });

  it('fails when a cited field is dropped from the issue leaf (bypass probe)', () => {
    // Proves the assertion above has teeth: a checklist naming `beats` against a
    // leaf that no longer renders it must be caught, not silently pass.
    const renderableWithoutBeats = new Set(
      [...renderableFields()].filter((field) => field !== 'beats'),
    );
    const cited = 'Beat-level findings are only valid against issues that have `beats`.';
    expect(unrenderableIn(cited, renderableWithoutBeats)).toEqual(['beats']);
  });

  it.each(SCOPED_CITATIONS)('renders %s on the %s the checklist reads it from', (field, _scope, rendered) => {
    expect([...rendered()]).toContain(field);
  });

  it('catches a scoped drop the other renderer would mask (bypass probe)', () => {
    // `synopsis` lives on BOTH renderers, so the union assertion alone cannot
    // see the issue leaf losing it — the volume node's copy keeps the union
    // satisfied while every beat/synopsis-depth check silently loses its input.
    const leafWithoutSynopsis = new Set([...issueLeafFields()].filter((f) => f !== 'synopsis'));
    const union = new Set([...leafWithoutSynopsis, ...Object.keys(renderVolumeFields({}))]);
    expect(union.has('synopsis')).toBe(true); // masked by the volume node…
    expect(leafWithoutSynopsis.has('synopsis')).toBe(false); // …but caught here.
  });

  it('renders every {{volume.*}} field the prompt interpolates', async () => {
    const markdown = await readShippedPrompt(PROMPT);
    const rendered = new Set(Object.keys(renderVolumeFields({})));
    const missing = [...namespacedVars(markdown, 'volume')].filter((v) => !rendered.has(v));
    expect(missing).toEqual([]);
  });

  it('fails when an interpolated volume field is dropped (bypass probe)', () => {
    // A renamed/removed volume field renders as an empty Mustache slot, so the
    // prompt silently judges the volume against a blank `endingHook` instead of
    // erroring — exactly the drift this half of the contract has to catch.
    const rendered = new Set(
      Object.keys(renderVolumeFields({})).filter((field) => field !== 'endingHook'),
    );
    const cited = namespacedVars('- **Ending hook:** {{volume.endingHook}}', 'volume');
    expect([...cited].filter((v) => !rendered.has(v))).toEqual(['endingHook']);
  });
});

describe('renderVolumeIssue depth selection', () => {
  const issue = {
    number: 4,
    title: 'Example Issue',
    status: 'draft',
    arcPosition: 4,
    stages: { idea: { input: 'seed synopsis', output: 'beat sheet' } },
  };

  it('renders beats (and never synopsis) once the expand pass has run', () => {
    expect(renderVolumeIssue(issue)).toEqual({
      number: 4, title: 'Example Issue', status: 'draft', arcPosition: 4, beats: 'beat sheet',
    });
  });

  it('renders synopsis (and never beats) when synopsisOnly is requested', () => {
    expect(renderVolumeIssue(issue, { synopsisOnly: true })).toEqual({
      number: 4, title: 'Example Issue', status: 'draft', arcPosition: 4, synopsis: 'seed synopsis',
    });
  });

  it('nulls synopsis rather than emitting an empty string for an unseeded issue', () => {
    expect(renderVolumeIssue({ ...issue, stages: {} }).synopsis).toBeNull();
  });
});
