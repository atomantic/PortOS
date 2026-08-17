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

import { renderVolumeIssue, renderVolumeFields, sliceSeasonForNeighbor } from './context.js';
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

const volumeNodeFields = () => new Set(Object.keys(renderVolumeFields({})));

// `neighborsJson` — the immediately-prior/next volumes check #5 reads across the
// boundary. A THIRD renderer feeding this one prompt, and a strict subset of the
// volume node's fields, so the union below can never see it lose one.
const neighborFields = () => new Set(Object.keys(sliceSeasonForNeighbor({})));

// Deliberately NOT unioned with `neighborFields()`: the neighbor shape is a
// subset of the volume node's, so folding it in would only give a dropped volume
// field somewhere else to hide. Scope-specific coverage is `SCOPED_CITATIONS`.
const renderableFields = () => new Set([
  ...issueLeafFields(),
  ...volumeNodeFields(),
]);

// Citations the checklist makes in a SPECIFIC scope. The union assertion below
// only proves a cited field is rendered somewhere, which is blind to a name that
// exists on more than one of the three renderers: `synopsis` sits on both the
// issue leaf and the volume node, and `logline`/`endingHook` on both the volume
// node and its neighbors — so any one of them could drop the field and another
// would mask the loss. These pin the owner. New tokens still get caught by the
// union check; this table only carries the names the generic scan cannot
// attribute on its own.
const SCOPED_CITATIONS = [
  // "Each entry has either `beats` … OR just `synopsis`" — the issue leaf.
  ['beats', 'issue leaf', issueLeafFields],
  ['synopsis', 'issue leaf', issueLeafFields],
  ['arcPosition', 'issue leaf', issueLeafFields],
  ['arcRole', 'issue leaf', issueLeafFields],
  ['lengthProfile', 'issue leaf', issueLeafFields],
  ['pageTarget', 'issue leaf', issueLeafFields],
  ['minutesTarget', 'issue leaf', issueLeafFields],
  // Checks #1/#4/#5 read these off the volume node.
  ['logline', 'volume node', volumeNodeFields],
  ['synopsis', 'volume node', volumeNodeFields],
  ['endingHook', 'volume node', volumeNodeFields],
  // Check #5 reads the PRIOR volume's `endingHook` and the NEXT volume's
  // `logline` — off the neighbor slice, not the volume under review.
  ['logline', 'neighbor volume', neighborFields],
  ['endingHook', 'neighbor volume', neighborFields],
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

  it.each([
    ['issue leaf', 'synopsis', issueLeafFields, volumeNodeFields],
    ['neighbor volume', 'logline', neighborFields, volumeNodeFields],
  ])('catches %s losing %s where another renderer would mask it (bypass probe)', (
    _scope, field, ownFields, maskingFields,
  ) => {
    const stripped = new Set([...ownFields()].filter((f) => f !== field));
    const union = new Set([...stripped, ...maskingFields()]);
    expect(union.has(field)).toBe(true); // masked by the other renderer…
    expect(stripped.has(field)).toBe(false); // …but caught by the scoped check.
  });

  it('renders every {{volume.*}} field the prompt interpolates', async () => {
    const markdown = await readShippedPrompt(PROMPT);
    const rendered = volumeNodeFields();
    const missing = [...namespacedVars(markdown, 'volume')].filter((v) => !rendered.has(v));
    expect(missing).toEqual([]);
  });

  it('reads the field named inside a location form, not just its prefix', () => {
    // `location` values embed a real field on the right of the colon
    // (`episode:<arcPosition>`). Splitting at the colon and stopping there would
    // let a substituted placeholder name a field nothing renders, so the scan
    // has to descend into the angle brackets. Asserted directly because
    // SCOPED_CITATIONS pins `arcPosition` independently and would stay green.
    const tokens = backtickedTokens('Use `episode:<arcPosition>` or `episode:<n>-<n+1>`.');
    expect([...tokens].sort()).toEqual(['arcPosition', 'episode', 'n']);
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
      number: 4, title: 'Example Issue', status: 'draft', arcPosition: 4,
      arcRole: null, lengthProfile: null, pageTarget: 22, minutesTarget: 24,
      beats: 'beat sheet',
    });
  });

  it('renders synopsis (and never beats) when synopsisOnly is requested', () => {
    expect(renderVolumeIssue(issue, { synopsisOnly: true })).toEqual({
      number: 4, title: 'Example Issue', status: 'draft', arcPosition: 4,
      arcRole: null, lengthProfile: null, pageTarget: 22, minutesTarget: 24,
      synopsis: 'seed synopsis',
    });
  });

  it('nulls synopsis rather than emitting an empty string for an unseeded issue', () => {
    expect(renderVolumeIssue({ ...issue, stages: {} }).synopsis).toBeNull();
  });

  it('materializes custom numeric targets for metadata-fit checks', () => {
    expect(renderVolumeIssue({
      ...issue,
      lengthProfile: 'custom',
      pageTarget: 4,
      minutesTarget: 120,
    })).toMatchObject({
      lengthProfile: 'custom',
      pageTarget: 4,
      minutesTarget: 120,
    });
  });
});
