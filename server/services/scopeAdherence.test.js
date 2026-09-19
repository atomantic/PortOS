import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('./jevRouter.js', () => ({
  isJevFeatureEnabled: vi.fn(),
  runJevDecision: vi.fn(),
  recordJevObservations: vi.fn(),
}));
vi.mock('./untrustedContent.js', () => ({ screenUntrustedContent: vi.fn() }));

const { isJevFeatureEnabled, runJevDecision, recordJevObservations } = await import('./jevRouter.js');
const { screenUntrustedContent } = await import('./untrustedContent.js');
const { scoreAdherence, loadClauseCorpus, resetClauseCorpusCache } = await import('./scopeAdherence.js');
const { getJevDecision } = await import('../lib/jevDecisions.js');

const decided = (value, margin) => ({ ok: true, kind: 'decided', value, margin, confidence: margin });
const abstained = (margin) => ({ ok: true, kind: 'abstained', abstained: true, margin });

const PRD = `# Example Product

## Agent Orchestration

The system MUST route every agent task to a provider automatically and without human intervention.

The system SHOULD learn provider routing weights from observed agent task outcomes over time.

## Knowledge Capture

The system MUST index every captured note for hybrid retrieval by the operator.

## Out of Scope

The system MUST NOT expose any agent, provider, or task to the public internet.
`;

const GOALS = `# Example Goals

## Knowledge Capture

Captured notes are indexed for hybrid retrieval so the operator can find them again later.

## Autonomous Agents

Agent tasks are generated from goals and routed to the best provider without the operator intervening.
`;

let repoPath;

beforeEach(async () => {
  // resetAllMocks, not clearAllMocks: a leftover `mockResolvedValueOnce`
  // queue would fire in the next test and score a change nobody asked about.
  vi.resetAllMocks();
  resetClauseCorpusCache();
  repoPath = await mkdtemp(join(tmpdir(), 'portos-scope-'));
  await writeFile(join(repoPath, 'PRD.md'), PRD);
  await writeFile(join(repoPath, 'GOALS.md'), GOALS);
  isJevFeatureEnabled.mockResolvedValue(true);
  screenUntrustedContent.mockResolvedValue({ ok: true, safe: true });
  runJevDecision.mockResolvedValue(abstained(0.01));
  recordJevObservations.mockResolvedValue(null);
});

afterEach(() => rm(repoPath, { force: true, recursive: true }));

const score = (overrides = {}) => scoreAdherence({
  kind: 'pr',
  title: 'Route agent tasks to the best provider automatically',
  body: 'Adds automatic provider routing for every queued agent task.',
  repoPath,
  ...overrides,
});

describe('scoreAdherence', () => {
  it('declines before touching the scorer when the jev feature is off', async () => {
    isJevFeatureEnabled.mockResolvedValue(false);
    expect(await score()).toEqual({ ok: false, code: 'scope-adherence-disabled' });
    // The whole point of the feature gate: an install that never opted in must
    // not screen, read the corpus, or wake a 9 GB sidecar.
    expect(screenUntrustedContent).not.toHaveBeenCalled();
    expect(runJevDecision).not.toHaveBeenCalled();
  });

  it('asks the shared jev registry entry, not a locally-worded question', async () => {
    await score({ topK: 1 });
    // The hypotheses are the whole instruction surface of the feature. They
    // live in `lib/jevDecisions.js` beside the untrusted-content rungs so one
    // diff shows every closed-set question the local scorer may be asked.
    expect(runJevDecision).toHaveBeenCalledWith(expect.objectContaining({ decisionId: 'scope-adherence' }));
    expect(getJevDecision('scope-adherence').options.map((option) => option.value))
      .toEqual(['aligned', 'unrelated', 'contradicts']);
  });

  it('screens the exact text it then scores, and reports a block with the screening code', async () => {
    screenUntrustedContent.mockResolvedValue({ ok: false, code: 'untrusted-content-blocked' });
    expect(await score({ kind: 'issue', diffSummary: 'server/routes/public.js' }))
      .toEqual({ ok: false, code: 'untrusted-content-blocked' });
    expect(runJevDecision).not.toHaveBeenCalled();

    const [[screenCall]] = screenUntrustedContent.mock.calls;
    expect(screenCall.source).toBe('github-issue');
    // The regression: `diffSummary` reaches the model inside the premise, so
    // screening a title+body subset would let unscreened text past phase 1.
    expect(screenCall.content).toContain('server/routes/public.js');
    expect(screenCall.content).toContain('Route agent tasks');
  });

  it('reads the corpus and retrieves BEFORE screening, so a hopeless click costs no classifier run', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'portos-scope-empty-'));
    expect(await score({ repoPath: empty })).toEqual({ ok: false, code: 'scope-adherence-corpus-missing' });
    // Both steps are inert with respect to the untrusted text (file reads and
    // in-process BM25), and most managed apps have no PRD at all — paying a
    // model-abuse inference to be told so is the one cost that repeats.
    expect(screenUntrustedContent).not.toHaveBeenCalled();
    await rm(empty, { recursive: true, force: true });
  });

  it('scores at most topK clauses, never the whole corpus', async () => {
    const result = await score({ topK: 2 });
    // Retrieval is the cost control: without it every clause is a separate
    // forward pass through a 4B model. Asserting the exact count rather than
    // just a ceiling also catches a retrieval regression that quietly returns
    // one clause (or none) and makes the bound vacuously true.
    expect(runJevDecision.mock.calls.length).toBe(2);
    expect(result.scored).toBe(2);
    expect((await loadClauseCorpus(repoPath)).clauses.length).toBeGreaterThan(2);
  });

  it('abstains rather than guessing when no clause separates the options', async () => {
    const result = await score();
    expect(result).toMatchObject({ ok: true, verdict: 'abstained', clauseId: null, clause: null });
    expect(result.margin).toBe(0.01);
  });

  it('reports a contradiction ahead of an alignment found on a better-ranked clause', async () => {
    runJevDecision
      .mockResolvedValueOnce(decided('aligned', 0.9))
      .mockResolvedValueOnce(decided('contradicts', 0.3))
      .mockResolvedValue(abstained(0.02));

    const result = await score();
    // A `contradicts` buried behind a wide `aligned` is the single most useful
    // thing this feature can say; ranking by margin alone would bury it.
    expect(result.verdict).toBe('contradicts');
    expect(result.clauseId).toMatch(/^(PRD|GOALS)\.md#/);
    // The citation ships as a field so the browser never re-spells it.
    expect(result.clause.citation).toMatch(/^(PRD|GOALS)\.md( § .+)?$/);
  });

  it('records counts for every clause it asked about, and nothing about the change', async () => {
    runJevDecision.mockResolvedValueOnce(decided('aligned', 0.8)).mockResolvedValue(abstained(0.02));
    await score({ topK: 2 });

    const [[rows]] = recordJevObservations.mock.calls;
    expect(rows).toEqual([
      { decisionId: 'scope-adherence', kind: 'decided' },
      { decisionId: 'scope-adherence', kind: 'abstained' },
    ]);
    // Counts only. A premise, a clause, or a margin tied to one would make the
    // shared agreement file unsafe to leave on.
    expect(JSON.stringify(rows)).not.toMatch(/Route agent tasks|PRD\.md/);
  });

  it('stops at an unavailable scorer, reports it as itself, and still records the attempt', async () => {
    runJevDecision.mockResolvedValue({ ok: false, kind: 'unavailable', code: 'jev-not-installed' });
    expect(await score({ topK: 3 })).toEqual({ ok: false, code: 'jev-not-installed' });
    // The remaining clauses would fail identically, so one call is the whole
    // cost of an uninstalled scorer.
    expect(runJevDecision).toHaveBeenCalledTimes(1);
    expect(recordJevObservations).toHaveBeenCalledWith([{ decisionId: 'scope-adherence', kind: 'unavailable' }]);
  });

  it('refuses a checkout with no product documents instead of grading it against this install\'s PRD', async () => {
    // No default `repoPath`: an app record that never set one must not silently
    // be scored against PortOS's own goals.
    expect(await score({ repoPath: undefined })).toEqual({ ok: false, code: 'scope-adherence-corpus-missing' });
    expect(await score({ repoPath: '' })).toEqual({ ok: false, code: 'scope-adherence-corpus-missing' });
    expect(runJevDecision).not.toHaveBeenCalled();
  });

  it('rereads the corpus after the product documents change on disk', async () => {
    const first = await loadClauseCorpus(repoPath);
    await writeFile(join(repoPath, 'PRD.md'), `${PRD}\n## Added\n\nA newly stated requirement that did not exist a moment ago.\n`);
    const second = await loadClauseCorpus(repoPath);
    expect(second.clauses.length).toBe(first.clauses.length + 1);
    // The BM25 index is cached beside the corpus and must be rebuilt with it,
    // or retrieval keeps answering from the superseded clause set.
    expect(second.index.totalDocs).toBe(second.clauses.length);
  });

  it('distinguishes an unreadable corpus from an absent one', async () => {
    const broken = await mkdtemp(join(tmpdir(), 'portos-scope-broken-'));
    // A directory where a file is expected: readable path, unreadable file.
    await mkdir(join(broken, 'PRD.md'));
    await mkdir(join(broken, 'GOALS.md'));
    expect(await loadClauseCorpus(broken)).toEqual({ ok: false, code: 'scope-adherence-corpus-unreadable' });
    await rm(broken, { recursive: true, force: true });
  });
});

describe('the advisory contract', () => {
  it('returns advisory fields only — nothing a caller could branch a write on', async () => {
    runJevDecision.mockResolvedValue(decided('contradicts', 0.8));
    const result = await score();
    expect(Object.keys(result).sort()).toEqual(['clause', 'clauseId', 'margin', 'ok', 'scored', 'verdict']);
  });

  it('keeps every scope-adherence module free of write, label, and task-spawn calls', async () => {
    // The acceptance criterion "no write path acts on the verdict", enforced
    // where a regression would actually appear: the day someone adds a forge
    // write or a task spawn here, this fails. ETHOS.md treats the absence of a
    // gate as the feature, not an omission.
    const root = join(import.meta.dirname, '..');
    const sources = await Promise.all([
      readFile(join(root, 'services', 'scopeAdherence.js'), 'utf8'),
      readFile(join(root, 'lib', 'scopeAdherence.js'), 'utf8'),
      readFile(join(root, 'routes', 'apps', 'scopeAdherence.js'), 'utf8'),
    ]);
    const forbidden = /(writeFile|atomicWrite|createCachedStore|\.mutate\(|addLabel|removeLabel|createTask|addTask|spawnAgent|runGh|execGh|ghJson|glabJson|'close'|"close"|issue close|pr merge)/;
    for (const source of sources) {
      // Comments narrate what the feature refuses to do, so only real code lines count.
      const code = source.split('\n').filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line)).join('\n');
      expect(code).not.toMatch(forbidden);
    }
    // The guard is only as good as its window: prove it fires on the shape it
    // is meant to catch, so a rename cannot quietly turn it into a no-op.
    expect("const x = await runGh('issue', 'close');").toMatch(forbidden);
  });
});
