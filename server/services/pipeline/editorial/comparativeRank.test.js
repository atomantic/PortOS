import { describe, it, expect, vi, beforeEach } from 'vitest';

// I/O mocked; PATHS/safeJSONParse stay real so the snapshot round-trip runs
// against the actual parser (mirrors pipelineJudge.test.js).
const fileStore = new Map();
vi.mock('../../../lib/fileUtils.js', async (importActual) => ({
  ...(await importActual()),
  tryReadFile: vi.fn(async (p) => (fileStore.has(p) ? fileStore.get(p) : null)),
  atomicWrite: vi.fn(async (p, data) => { fileStore.set(p, JSON.stringify(data)); }),
  ensureDir: vi.fn(async () => {}),
}));

vi.mock('../../../lib/stageRunner.js', () => ({
  runStagedLLM: vi.fn(),
  resolveStageContext: vi.fn(async () => ({ contextWindow: 200_000 })),
}));

vi.mock('../issues.js', async (importActual) => ({
  ...(await importActual()),
  listIssues: vi.fn(async () => []),
}));

// pickJudgeContent is imported from pipelineJudge — stub it to avoid pulling the
// judge's heavy graph; return the issue's prose text.
vi.mock('../pipelineJudge.js', () => ({
  pickJudgeContent: vi.fn((issue) => {
    const text = issue?.stages?.prose?.output || issue?.text || '';
    return text ? { text, sourceStage: 'prose' } : null;
  }),
}));

vi.mock('../readerPanelDigest.js', () => ({
  computeSourceContentHash: vi.fn(async () => 'HASH-v1'),
}));

const fileUtils = await import('../../../lib/fileUtils.js');
const stageRunner = await import('../../../lib/stageRunner.js');
const issuesSvc = await import('../issues.js');
const digest = await import('../readerPanelDigest.js');
const {
  expectedScore,
  updateRatings,
  pairSwissRound,
  effectiveRounds,
  runSwissTournament,
  parseCompareWinner,
  tiebreakWinner,
  runComparativeRank,
  getComparativeRank,
  eligibleIssues,
  START_RATING,
  ELO_K,
  __testing,
} = await import('./comparativeRank.js');

const makeIssue = (n, text = `prose ${n}`) => ({
  id: `iss-${n}`,
  number: n,
  arcPosition: n,
  title: `Issue ${n}`,
  stages: { prose: { output: text } },
});

beforeEach(() => {
  fileStore.clear();
  vi.clearAllMocks();
  digest.computeSourceContentHash.mockResolvedValue('HASH-v1');
  stageRunner.resolveStageContext.mockResolvedValue({ contextWindow: 200_000 });
});

describe('Elo math', () => {
  it('expectedScore is 0.5 for equal ratings and symmetric', () => {
    expect(expectedScore(1000, 1000)).toBeCloseTo(0.5, 10);
    expect(expectedScore(1200, 1000) + expectedScore(1000, 1200)).toBeCloseTo(1, 10);
    expect(expectedScore(1400, 1000)).toBeGreaterThan(0.9);
  });

  it('updateRatings is zero-sum; the winner gains what the loser loses', () => {
    const { a, b } = updateRatings(1000, 1000, 'a', 32);
    expect(a).toBeCloseTo(1016, 6);   // 1000 + 32*(1-0.5)
    expect(b).toBeCloseTo(984, 6);
    expect((a - 1000) + (b - 1000)).toBeCloseTo(0, 9);
  });

  it("an upset (low-rated beats high-rated) moves ratings more than an expected win", () => {
    const upset = updateRatings(1000, 1400, 'a', 32);       // underdog A wins
    const expectedWin = updateRatings(1400, 1000, 'a', 32); // favorite A wins
    expect(upset.a - 1000).toBeGreaterThan(expectedWin.a - 1400);
  });

  it("'b' win mirrors 'a' win", () => {
    const aWin = updateRatings(1050, 1000, 'a', 32);
    const bWin = updateRatings(1050, 1000, 'b', 32);
    expect(aWin.a).toBeGreaterThan(1050);
    expect(bWin.a).toBeLessThan(1050);
    expect(bWin.b).toBeGreaterThan(1000);
  });
});

describe('Swiss pairing (pure)', () => {
  it('pairs an even field top-down and returns no bye', () => {
    const standings = [
      { id: 'a', score: 2, rating: 1030 },
      { id: 'b', score: 1, rating: 1010 },
      { id: 'c', score: 1, rating: 1000 },
      { id: 'd', score: 0, rating: 980 },
    ];
    const { pairs, bye } = pairSwissRound(standings);
    expect(bye).toBeNull();
    expect(pairs).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('gives the odd field a bye to the lowest-ranked not-yet-bye player', () => {
    const standings = [
      { id: 'a', score: 1, rating: 1020 },
      { id: 'b', score: 1, rating: 1010 },
      { id: 'c', score: 0, rating: 1000 },
    ];
    const { pairs, bye } = pairSwissRound(standings);
    expect(bye).toBe('c');
    expect(pairs).toEqual([['a', 'b']]);
  });

  it('does not give a second bye to a player who already had one, when avoidable', () => {
    const standings = [
      { id: 'a', score: 1, rating: 1020 },
      { id: 'b', score: 1, rating: 1010 },
      { id: 'c', score: 0, rating: 1000 },
    ];
    const { bye } = pairSwissRound(standings, new Set(), new Set(['c']));
    expect(bye).toBe('b'); // c already had a bye → next-lowest not-yet-bye
  });

  it('avoids a rematch when an alternative unplayed opponent exists', () => {
    const standings = [
      { id: 'a', score: 1, rating: 1020 },
      { id: 'b', score: 1, rating: 1010 },
      { id: 'c', score: 1, rating: 1005 },
      { id: 'd', score: 1, rating: 1000 },
    ];
    const played = new Set([__testing.pairKey('a', 'b')]);
    const { pairs } = pairSwissRound(standings, played);
    expect(pairs).not.toContainEqual(['a', 'b']);
    // a pairs with the next unplayed (c); leftover b-d pair.
    expect(pairs).toEqual([['a', 'c'], ['b', 'd']]);
  });

  it('falls back to a rematch only when every remaining opponent has been played', () => {
    const standings = [
      { id: 'a', score: 1, rating: 1020 },
      { id: 'b', score: 0, rating: 1000 },
    ];
    const played = new Set([__testing.pairKey('a', 'b')]);
    const { pairs } = pairSwissRound(standings, played);
    expect(pairs).toEqual([['a', 'b']]);
  });
});

describe('effectiveRounds', () => {
  it('caps rounds at n-1 for small fields and 0 for <2', () => {
    expect(effectiveRounds(1)).toBe(0);
    expect(effectiveRounds(2, 4)).toBe(1);
    expect(effectiveRounds(3, 4)).toBe(2);
    expect(effectiveRounds(5, 4)).toBe(4);
    expect(effectiveRounds(50, 4)).toBe(4);
  });
});

describe('runSwissTournament', () => {
  it('ranks a transitive field correctly (higher seed always wins)', async () => {
    const entrants = [makeIssue(1), makeIssue(2), makeIssue(3), makeIssue(4)];
    // Deterministic oracle: the lower issue number is the "better" draft.
    const playMatch = (a, b) => {
      const na = Number(a.split('-')[1]);
      const nb = Number(b.split('-')[1]);
      return na < nb ? 'a' : 'b';
    };
    const { ranking, matches } = await runSwissTournament(entrants, playMatch, { rounds: 4 });
    expect(ranking.map((r) => r.id)).toEqual(['iss-1', 'iss-2', 'iss-3', 'iss-4']);
    expect(matches.length).toBeGreaterThan(0);
    // Zero-sum: the mean rating is conserved at START_RATING.
    const mean = ranking.reduce((s, r) => s + r.rating, 0) / ranking.length;
    expect(mean).toBeCloseTo(START_RATING, 6);
  });

  it('handles an odd field with byes without crashing', async () => {
    const entrants = [makeIssue(1), makeIssue(2), makeIssue(3)];
    const playMatch = (a, b) => (a < b ? 'a' : 'b');
    const { ranking } = await runSwissTournament(entrants, playMatch, { rounds: 4 });
    expect(ranking).toHaveLength(3);
    expect(ranking[0].id).toBe('iss-1');
  });
});

describe('parseCompareWinner (tie-refusal handling)', () => {
  it('parses the accepted spellings for A and B', () => {
    for (const v of ['A', 'a', '1', 'first', 'Issue A']) {
      expect(parseCompareWinner({ winner: v })).toBe('a');
    }
    for (const v of ['B', 'b', '2', 'second', 'Issue B']) {
      expect(parseCompareWinner({ winner: v })).toBe('b');
    }
  });

  it('returns null for a tie / hedge / garbage so the caller applies a tiebreak', () => {
    expect(parseCompareWinner({ winner: 'tie' })).toBeNull();
    expect(parseCompareWinner({ winner: 'both' })).toBeNull();
    expect(parseCompareWinner({ winner: '' })).toBeNull();
    expect(parseCompareWinner({ winner: null })).toBeNull();
    expect(parseCompareWinner({})).toBeNull();
    expect(parseCompareWinner(null)).toBeNull();
    expect(parseCompareWinner('C')).toBeNull();
  });

  it('tiebreak is deterministic and picks a definite side', () => {
    const w1 = tiebreakWinner('iss-1', 'iss-2');
    const w2 = tiebreakWinner('iss-1', 'iss-2');
    expect(w1).toBe(w2);            // stable
    expect(['a', 'b']).toContain(w1);
    // Order-independent: swapping args still names the SAME issue as winner.
    const w3 = tiebreakWinner('iss-2', 'iss-1');
    // w1==='a' means iss-1 wins; from swapped view that's 'b'.
    expect(w3).toBe(w1 === 'a' ? 'b' : 'a');
  });
});

describe('runComparativeRank', () => {
  it('returns insufficient when fewer than two issues have drafted content', async () => {
    const result = await runComparativeRank('ser-1', { issues: [makeIssue(1)] });
    expect(result.status).toBe('insufficient');
    expect(result.eligible).toBe(1);
    expect(stageRunner.runStagedLLM).not.toHaveBeenCalled();
  });

  it('runs the tournament, persists a content-hash-pinned snapshot, and orders weakest-last', async () => {
    // Compare oracle: lower issue number always wins.
    stageRunner.runStagedLLM.mockImplementation(async (_stage, vars) => ({
      content: { winner: vars.issueA.number < vars.issueB.number ? 'A' : 'B', decidingPassage: 'q' },
    }));
    const issues = [makeIssue(1), makeIssue(2), makeIssue(3)];
    const snap = await runComparativeRank('ser-1', { issues });
    expect(snap.status).toBe('complete');
    expect(snap.sourceContentHash).toBe('HASH-v1');
    expect(snap.ranking[0].number).toBe(1); // best draft tops the ranking
    expect(snap.ranking[0].rank).toBe(1);
    // weakest slice is the reverse tail of the ranking (worst-first).
    expect(snap.weakest[0].issueId).toBe(snap.ranking[snap.ranking.length - 1].issueId);
    expect(snap.matches.length).toBeGreaterThan(0);
    expect(stageRunner.runStagedLLM).toHaveBeenCalled();
  });

  it('applies the deterministic tiebreak when the judge refuses to pick', async () => {
    stageRunner.runStagedLLM.mockResolvedValue({ content: { winner: 'tie' } });
    const issues = [makeIssue(1), makeIssue(2)];
    const snap = await runComparativeRank('ser-1', { issues });
    expect(snap.status).toBe('complete');
    expect(snap.matches.every((m) => m.forcedTiebreak)).toBe(true);
    expect(snap.ranking).toHaveLength(2);
  });

  it('stops early and flags budgetStopped when chargeAction returns false', async () => {
    stageRunner.runStagedLLM.mockResolvedValue({ content: { winner: 'A' } });
    const issues = [makeIssue(1), makeIssue(2), makeIssue(3), makeIssue(4)];
    let calls = 0;
    const chargeAction = async () => { calls += 1; return calls <= 1; }; // allow one match then cut off
    const snap = await runComparativeRank('ser-1', { issues, chargeAction });
    expect(snap.budgetStopped).toBe(true);
    // Only the first match actually ran the LLM (subsequent matches short-circuit).
    expect(stageRunner.runStagedLLM).toHaveBeenCalledTimes(1);
  });
});

describe('getComparativeRank staleness pinning', () => {
  it('flags a stored ranking stale when the drafted content hash moves', async () => {
    stageRunner.runStagedLLM.mockResolvedValue({ content: { winner: 'A' } });
    await runComparativeRank('ser-1', { issues: [makeIssue(1), makeIssue(2)] });

    // Same hash → fresh.
    let loaded = await getComparativeRank('ser-1');
    expect(loaded.status).toBe('complete');
    expect(loaded.stale).toBe(false);

    // Content moved → the pinned hash no longer matches → stale.
    digest.computeSourceContentHash.mockResolvedValue('HASH-v2');
    loaded = await getComparativeRank('ser-1');
    expect(loaded.stale).toBe(true);
  });

  it('returns status none when never run', async () => {
    const loaded = await getComparativeRank('ser-unknown');
    expect(loaded.status).toBe('none');
    expect(loaded.ranking).toEqual([]);
  });

  it('rejects a path-traversal-shaped series id', async () => {
    await expect(getComparativeRank('../etc')).rejects.toThrow(/Invalid series id/);
  });
});

describe('eligibleIssues', () => {
  it('keeps only drafted issues, sorted by arc position', async () => {
    const drafted = makeIssue(2);
    const undrafted = { id: 'iss-3', number: 3, arcPosition: 3, stages: {} };
    const first = makeIssue(1);
    const out = eligibleIssues([drafted, undrafted, first]);
    expect(out.map((i) => i.id)).toEqual(['iss-1', 'iss-2']);
  });
});

describe('runComparativeRank fetches issues when not provided', () => {
  it('loads the series issues via listIssues', async () => {
    issuesSvc.listIssues.mockResolvedValue([makeIssue(1), makeIssue(2)]);
    stageRunner.runStagedLLM.mockResolvedValue({ content: { winner: 'A' } });
    const snap = await runComparativeRank('ser-9');
    expect(issuesSvc.listIssues).toHaveBeenCalledWith({ seriesId: 'ser-9', withHistory: false });
    expect(snap.status).toBe('complete');
  });
});
