import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockNoPeerSync, mockNoPeers } from '../../lib/mockPathsDataRoot.js';

const fileStore = new Map();
let stageRunnerSpy;

vi.mock('../../lib/fileUtils.js', () => ({
tryReadFile: vi.fn().mockResolvedValue(null),
  PATHS: { data: '/mock/data' },
  ensureDir: vi.fn().mockResolvedValue(undefined),
  atomicWrite: vi.fn(async (path, data) => { fileStore.set(path, data); }),
  readJSONFile: vi.fn(async (path, fallback) => (fileStore.has(path) ? fileStore.get(path) : fallback)),
}));

let uuidCounter = 0;
vi.mock('crypto', async () => {
  const actual = await vi.importActual('crypto');
  return { ...actual, randomUUID: () => `uuid-${++uuidCounter}` };
});

vi.mock('../instances.js', () => mockNoPeers());
vi.mock('../sharing/peerSync.js', () => mockNoPeerSync());

// Stub the staged-LLM runner so the test owns the LLM response shape.
// Each test sets `stageRunnerSpy = vi.fn(...)` to control what comes back.
vi.mock('../stageRunner.js', () => ({
  runStagedLLM: vi.fn((...args) => stageRunnerSpy(...args)),
  extractJson: (raw) => JSON.parse(raw),
  // Large window so completeness runs as a single call (mode: 'whole').
  resolveStageContext: vi.fn(() => Promise.resolve({ provider: { id: 'p' }, model: 'm', contextWindow: 1_000_000 })),
}));

const seriesSvc = await import('./series.js');
const seasonsSvc = await import('./seasons.js');
const planner = await import('./arcPlanner.js');

async function setupSeries(overrides = {}) {
  return seriesSvc.createSeries({
    name: 'Salt Run',
    logline: 'A foundry city goes silent.',
    premise: 'Long-form premise.',
    styleNotes: 'moebius linework',
    issueCountTarget: 24,
    ...overrides,
  });
}

// The arc gate's per-finding fallback (#3780) sends ONE finding, but that alone
// never bounded the EDIT: every entry in a single-finding response trivially
// names that finding, so `selectFindingKeyedEdits` passed whole-arc rewrites and
// each "isolated" attempt regressed the blocker set exactly like the whole-set
// pass it escalated from. `isolated` mode requires the response to BE one causal
// patch and discards it before persistence otherwise.
describe('arcPlanner — resolveVerifyIssues (isolated single-finding repairs)', () => {
  const finding = [{ severity: 'high', location: 'volume 1', problem: 'volume 1 promises a payoff it never lands', suggestion: 'name the payoff' }];

  beforeEach(() => {
    fileStore.clear();
    uuidCounter = 0;
    stageRunnerSpy = undefined;
  });

  async function setupTwoVolumeSeries() {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, {
      arc: { logline: 'L', summary: 'The choir wakes. The city answers.', themes: ['legacy'], protagonistArc: 'From surveyor to founder.' },
    });
    const v1 = await seasonsSvc.createSeason(s.id, { title: 'Vol 1', episodeCountTarget: 8, synopsis: 'The foundry falls silent. Nobody says why.' });
    const v2 = await seasonsSvc.createSeason(s.id, { title: 'Vol 2', episodeCountTarget: 8, synopsis: 'The diaspora scatters. A signal follows them.' });
    return { s, v1, v2 };
  }

  it('discards an isolated candidate that edits more than one record, persisting nothing', async () => {
    const { s, v1, v2 } = await setupTwoVolumeSeries();
    stageRunnerSpy = vi.fn(async () => ({
      content: {
        patchMode: 'exact-text-v1',
        arc: { resolves: ['f1'], summaryEdits: [{ find: 'The city answers.', replace: 'The city answers in kind.' }] },
        seasons: [
          { resolves: ['f1'], id: v1.id, number: v1.number, title: 'Vol 1', synopsisEdits: [{ find: 'Nobody says why.', replace: 'Nobody says why until the ledger surfaces.' }] },
          { resolves: ['f1'], id: v2.id, number: v2.number, title: 'Vol 2', synopsisEdits: [{ find: 'A signal follows them.', replace: 'A signal follows them home.' }] },
        ],
        notes: '',
      },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    const out = await planner.resolveVerifyIssues(s.id, { findings: finding, isolated: true });

    expect(out.applied).toBe(false);
    expect(out.reason).toMatch(/edits 3 records/);
    // Nothing reached the store — the gate has no rewrite to roll back and no
    // reason to spend a verification round discovering that.
    const after = await seriesSvc.getSeries(s.id);
    expect(after.arc.summary).toBe('The choir wakes. The city answers.');
    expect(after.seasons.map((v) => v.synopsis)).toEqual([
      'The foundry falls silent. Nobody says why.',
      'The diaspora scatters. A signal follows them.',
    ]);
  });

  it('discards an isolated candidate that changes two fields on one record', async () => {
    const { s, v1 } = await setupTwoVolumeSeries();
    stageRunnerSpy = vi.fn(async () => ({
      content: {
        patchMode: 'exact-text-v1',
        seasons: [{
          resolves: ['f1'],
          id: v1.id,
          number: v1.number,
          title: 'Vol 1',
          logline: 'a brand new logline',
          synopsisEdits: [{ find: 'Nobody says why.', replace: 'Nobody says why until the ledger surfaces.' }],
        }],
        notes: '',
      },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    const out = await planner.resolveVerifyIssues(s.id, { findings: finding, isolated: true });

    expect(out.applied).toBe(false);
    expect(out.reason).toMatch(/changes 2 fields on volume 1/);
    const after = await seriesSvc.getSeries(s.id);
    expect(after.seasons[0].synopsis).toBe('The foundry falls silent. Nobody says why.');
    expect(after.seasons[0].logline).toBe('');
  });

  it('discards an isolated candidate that would add a volume', async () => {
    const { s } = await setupTwoVolumeSeries();
    stageRunnerSpy = vi.fn(async () => ({
      content: {
        patchMode: 'exact-text-v1',
        seasons: [{ resolves: ['f1'], number: 3, title: 'Vol 3', synopsis: 'The payoff gets its own volume.' }],
        notes: '',
      },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    const out = await planner.resolveVerifyIssues(s.id, { findings: finding, isolated: true });

    expect(out.applied).toBe(false);
    expect(out.reason).toMatch(/add a new volume/);
    expect((await seriesSvc.getSeries(s.id)).seasons).toHaveLength(2);
  });

  it('keeps a one-patch candidate, ignoring echoed identity fields that change nothing', async () => {
    const { s, v1 } = await setupTwoVolumeSeries();
    stageRunnerSpy = vi.fn(async () => ({
      content: {
        patchMode: 'exact-text-v1',
        seasons: [{
          // id / number / title / episodeCountTarget are echoed exactly as
          // stored — the prompt asks for them, so "present" must not read as
          // "changed" or every real one-patch response would be discarded.
          resolves: ['f1'],
          id: v1.id,
          number: v1.number,
          title: 'Vol 1',
          episodeCountTarget: 8,
          synopsisEdits: [{ find: 'Nobody says why.', replace: 'Nobody says why until the ledger surfaces.' }],
        }],
        notes: '',
      },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    const out = await planner.resolveVerifyIssues(s.id, { findings: finding, isolated: true });

    expect(out.applied).toBe(true);
    expect(out.reason).toBeUndefined();
    const after = await seriesSvc.getSeries(s.id);
    expect(after.seasons[0].synopsis).toBe('The foundry falls silent. Nobody says why until the ledger surfaces.');
    expect(after.seasons[1].synopsis).toBe('The diaspora scatters. A signal follows them.');
  });

  it('discards a candidate that only echoes stored values back', async () => {
    const { s, v1 } = await setupTwoVolumeSeries();
    stageRunnerSpy = vi.fn(async () => ({
      content: {
        patchMode: 'exact-text-v1',
        seasons: [{ resolves: ['f1'], id: v1.id, number: v1.number, title: 'Vol 1', episodeCountTarget: 8 }],
        notes: 'nothing to change here',
      },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    const out = await planner.resolveVerifyIssues(s.id, { findings: finding, isolated: true });

    expect(out.applied).toBe(false);
    expect(out.reason).toMatch(/changed nothing/);
    expect(out.notes).toBe('nothing to change here');
  });

  it('tells the prompt it is an isolated repair, and does not on a whole-set pass', async () => {
    const { s, v1 } = await setupTwoVolumeSeries();
    stageRunnerSpy = vi.fn(async () => ({
      content: {
        patchMode: 'exact-text-v1',
        seasons: [{ resolves: ['f1'], id: v1.id, synopsisEdits: [{ find: 'Nobody says why.', replace: 'Nobody says why yet.' }] }],
        notes: '',
      },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    await planner.resolveVerifyIssues(s.id, { findings: finding, isolated: true });
    expect(stageRunnerSpy.mock.calls[0][1].isolatedRepair).toBe(true);

    await planner.resolveVerifyIssues(s.id, { findings: finding });
    expect(stageRunnerSpy.mock.calls[1][1].isolatedRepair).toBe(false);
  });

  // The constrained mode is the bounded FALLBACK only: coordinated cross-record
  // repairs stay available to the whole-set and corrective passes, which is
  // where a genuine multi-record continuity finding gets fixed.
  it('leaves the whole-set pass free to edit several records', async () => {
    const { s, v1, v2 } = await setupTwoVolumeSeries();
    stageRunnerSpy = vi.fn(async () => ({
      content: {
        patchMode: 'exact-text-v1',
        arc: { resolves: ['f1'], summaryEdits: [{ find: 'The city answers.', replace: 'The city answers in kind.' }] },
        seasons: [
          { resolves: ['f1'], id: v1.id, synopsisEdits: [{ find: 'Nobody says why.', replace: 'Nobody says why until the ledger surfaces.' }] },
          { resolves: ['f1'], id: v2.id, synopsisEdits: [{ find: 'A signal follows them.', replace: 'A signal follows them home.' }] },
        ],
        notes: '',
      },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    const out = await planner.resolveVerifyIssues(s.id, { findings: finding });

    expect(out.applied).toBe(true);
    const after = await seriesSvc.getSeries(s.id);
    expect(after.arc.summary).toBe('The choir wakes. The city answers in kind.');
    expect(after.seasons[0].synopsis).toContain('until the ledger surfaces');
    expect(after.seasons[1].synopsis).toContain('follows them home');
  });
});

describe('isolatedCandidateRejection (pure one-patch bound)', () => {
  const series = {
    arc: { logline: 'L', summary: 'One. Two.', themes: ['a'], protagonistArc: 'P' },
    seasons: [{ id: 'sea-1', number: 1, title: 'Vol 1', synopsis: 'Alpha. Beta.', endingHook: 'hook', episodeCountTarget: 8, themes: [] }],
    characterArcs: [{
      characterId: 'chr-11111111-1111-4111-8111-111111111111',
      characterName: 'Wren',
      want: 'the ledger',
      need: 'to be believed',
      startState: 'alone',
      endState: 'trusted',
            transitions: [{ id: 'trn-1', kind: 'decision', label: 'burns the ledger', atIssue: 4, atSceneAnchor: '', note: '' }],
    }],
  };
  // Only the four edit lists — the checker reads the selected edits, never the
  // drop counters `selectFindingKeyedEdits` reports alongside them.
  const noEdits = { arc: null, characterArcs: [], seasons: [], episodes: [] };
  const rejection = (edits, exactTextMode = true) => planner.isolatedCandidateRejection(
    { ...noEdits, ...edits },
    { exactTextMode, series },
  );

  it('accepts one exact-text replacement on one volume', () => {
    expect(rejection({ seasons: [{ id: 'sea-1', synopsisEdits: [{ find: 'Beta.', replace: 'Beta rewritten.' }] }] })).toBeNull();
  });

  it('accepts one short scalar change', () => {
    expect(rejection({ seasons: [{ id: 'sea-1', episodeCountTarget: 9 }] })).toBeNull();
  });

  it('accepts one existing character-transition patch, however many of its fields move', () => {
    expect(rejection({
      characterArcs: [{
        characterId: 'chr-11111111-1111-4111-8111-111111111111',
        transitions: [{ id: 'trn-1', label: 'spares the ledger', atIssue: 5 }],
      }],
    })).toBeNull();
  });

  it('rejects two replacements even inside one field', () => {
    expect(rejection({
      seasons: [{ id: 'sea-1', synopsisEdits: [{ find: 'Alpha.', replace: 'Alpha!' }, { find: 'Beta.', replace: 'Beta!' }] }],
    })).toMatch(/changes 2 fields/);
  });

  it('does not count the long-prose spelling the applier ignores', () => {
    // Under exact-text mode a directly-returned `synopsis` is never persisted,
    // so counting it would reject a candidate over an edit that was a no-op.
    expect(rejection({
      seasons: [{ id: 'sea-1', synopsis: 'wholesale rewrite', synopsisEdits: [{ find: 'Beta.', replace: 'Beta rewritten.' }] }],
    })).toBeNull();
    // Outside exact-text mode the same field IS the change.
    expect(rejection({ seasons: [{ id: 'sea-1', synopsis: 'wholesale rewrite' }] }, false)).toBeNull();
  });

  it('counts what the exact-text applier would land, not what was asked for', () => {
    // A replacement whose anchor isn't in the stored text is skipped by
    // applyExactTextEdits, so it changes nothing — counting it would discard a
    // candidate whose persisted effect was exactly one change.
    expect(rejection({
      seasons: [{
        id: 'sea-1',
        synopsisEdits: [
          { find: 'Beta.', replace: 'Beta rewritten.' },
          { find: 'text that is not in the synopsis', replace: 'never lands' },
        ],
      }],
    })).toBeNull();
    // …and a candidate whose every replacement is unanchored lands nothing at all.
    expect(rejection({
      seasons: [{ id: 'sea-1', synopsisEdits: [{ find: 'not present either', replace: 'x' }] }],
    })).toMatch(/changed nothing/);
  });

  it('does not count edits the appliers would discard anyway', () => {
    expect(rejection({
      characterArcs: [
        { characterName: 'Nobody', want: 'invented' }, // unmatched arc — never minted
        {
          characterId: 'chr-11111111-1111-4111-8111-111111111111',
          transitions: [
            { label: 'no id, dropped by the merge' },
            { id: 'trn-missing', label: 'unmatched id, dropped by the merge' },
            { id: 'trn-1', label: 'burns the ledger' }, // identical to stored
          ],
          want: 'the ledger archive',
        },
      ],
    })).toBeNull();
  });
});

describe('selectFindingKeyedEdits (pure resolve-edit filter, #3724)', () => {
  const findings = [{ problem: 'a' }, { problem: 'b' }];
  const select = (content) => planner.selectFindingKeyedEdits(content, findings);

  it('keeps edits naming an input finding and drops the rest', () => {
    const out = select({
      arc: { resolves: ['f2'], logline: 'x' },
      characterArcs: [{ resolves: ['f2'], characterId: 'chr-a' }, { resolves: ['f8'], characterId: 'chr-b' }],
      seasons: [{ resolves: ['f1'] }, { resolves: ['f7'] }, { resolves: [] }],
      episodes: [{ resolves: ['f1'] }, {}],
    });
    expect(out.legacy).toBe(false);
    expect(out.arc?.logline).toBe('x');
    expect(out.arcDropped).toBe(false);
    expect(out.characterArcs).toHaveLength(1);
    expect(out.characterArcsDropped).toBe(1);
    expect(out.seasons).toHaveLength(1);
    expect(out.seasonsDropped).toBe(2);
    expect(out.episodes).toHaveLength(1);
    expect(out.episodesDropped).toBe(1);
  });

  it('normalizes ids (case + whitespace) and ignores non-string entries', () => {
    const out = select({ seasons: [{ resolves: [' F1 ', 42, null, 'f1'] }] });
    expect(out.seasons).toHaveLength(1);
  });

  it('drops an untargeted arc block while keeping the volumes that are targeted', () => {
    const out = select({ arc: { resolves: [] }, seasons: [{ resolves: ['f1'] }] });
    expect(out.arc).toBeNull();
    expect(out.arcDropped).toBe(true);
    expect(out.seasons).toHaveLength(1);
  });

  it('falls back to legacy (apply-all) only when NOTHING in the response declares resolves', () => {
    const legacy = select({ arc: { logline: 'x' }, seasons: [{ id: 's1' }], episodes: [{ synopsis: 'y' }] });
    expect(legacy).toMatchObject({ legacy: true, arcDropped: false, seasonsDropped: 0, episodesDropped: 0 });
    expect(legacy.arc?.logline).toBe('x');
    // One keyed entry proves the model is on the new contract — the unkeyed
    // siblings in the SAME response are then genuine drops, not legacy.
    expect(select({ seasons: [{ resolves: ['f1'] }, { id: 's2' }] }))
      .toMatchObject({ legacy: false, seasonsDropped: 1 });
  });

  // #3789 — a spine round's findings were produced against an episode-empty
  // plan, so every episode edit is out of scope no matter which finding it
  // names. Counted apart from `episodesDropped` (a different diagnosis) and
  // applied even to a legacy unkeyed response, which is the one an install with
  // a pre-#3789 prompt will send.
  it('drops every episode edit in spineOnly mode, keyed or not', () => {
    const spine = (content) => planner.selectFindingKeyedEdits(content, findings, { spineOnly: true });
    const keyed = spine({
      arc: { resolves: ['f1'], logline: 'x' },
      seasons: [{ resolves: ['f1'] }],
      episodes: [{ resolves: ['f1'] }, { resolves: ['f2'] }],
    });
    expect(keyed.arc?.logline).toBe('x');
    expect(keyed.seasons).toHaveLength(1);
    expect(keyed.episodes).toEqual([]);
    expect(keyed.episodesOutOfScope).toBe(2);
    expect(keyed.episodesDropped).toBe(0);
    expect(spine({ episodes: [{ synopsis: 'y' }] }))
      .toMatchObject({ legacy: true, episodes: [], episodesOutOfScope: 1 });
    // Full-arc rounds are untouched — episode corrections are how an
    // episode-scoped finding converges there.
    expect(select({ episodes: [{ resolves: ['f1'] }] }))
      .toMatchObject({ episodesOutOfScope: 0 });
  });

  it('tolerates a missing/garbage response', () => {
    expect(select(null)).toMatchObject({ legacy: true, arc: null, characterArcs: [], seasons: [], episodes: [] });
    expect(select({ arc: 'not an object', seasons: 'nope', episodes: [null, 3] }))
      .toMatchObject({ arc: null, seasons: [], episodes: [] });
  });
});
