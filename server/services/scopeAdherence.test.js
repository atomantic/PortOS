import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('./jevRouter.js', () => ({ isJevFeatureEnabled: vi.fn() }));
vi.mock('./untrustedContent.js', () => ({ screenUntrustedContent: vi.fn() }));
vi.mock('./jev.js', () => ({ decide: vi.fn() }));

const { isJevFeatureEnabled } = await import('./jevRouter.js');
const { screenUntrustedContent } = await import('./untrustedContent.js');
const { decide } = await import('./jev.js');
const { scoreAdherence, loadClauseCorpus, resetClauseCorpusCache } = await import('./scopeAdherence.js');
const { SCOPE_ADHERENCE_OPTIONS } = await import('../lib/scopeAdherence.js');

const hypothesis = (verdict) => SCOPE_ADHERENCE_OPTIONS.find((option) => option.verdict === verdict).hypothesis;

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
  decide.mockResolvedValue({ ok: true, abstained: true, margin: 0.01, choice: null });
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
    expect(decide).not.toHaveBeenCalled();
  });

  it('screens the change before scoring it, and reports a block with the screening code', async () => {
    screenUntrustedContent.mockResolvedValue({ ok: false, code: 'untrusted-content-blocked' });
    expect(await score({ kind: 'issue' })).toEqual({ ok: false, code: 'untrusted-content-blocked' });
    expect(screenUntrustedContent).toHaveBeenCalledWith(expect.objectContaining({ source: 'github-issue' }));
    expect(decide).not.toHaveBeenCalled();
  });

  it('scores at most topK clauses, never the whole corpus', async () => {
    const result = await score({ topK: 2 });
    // Retrieval is the cost control: without it every clause is a separate
    // forward pass through a 4B model. Asserting the exact count rather than
    // just a ceiling also catches a retrieval regression that quietly returns
    // one clause (or none) and makes the bound vacuously true.
    expect(decide.mock.calls.length).toBe(2);
    expect(result.scored).toBe(2);
    expect((await loadClauseCorpus(repoPath)).clauses.length).toBeGreaterThan(2);
    for (const [request] of decide.mock.calls) {
      expect(request.options).toEqual(SCOPE_ADHERENCE_OPTIONS.map((option) => option.hypothesis));
      expect(request.premise).toContain('Proposed change (pull request)');
    }
  });

  it('abstains rather than guessing when no clause separates the options', async () => {
    const result = await score();
    expect(result).toMatchObject({ ok: true, verdict: 'abstained', clauseId: null, clause: null });
    expect(result.margin).toBe(0.01);
    expect(result.advisory).not.toMatch(/advances|works against/);
  });

  it('reports a contradiction ahead of an alignment found on a better-ranked clause', async () => {
    decide
      .mockResolvedValueOnce({ ok: true, abstained: false, choice: hypothesis('aligned'), margin: 0.9, confidence: 0.95 })
      .mockResolvedValueOnce({ ok: true, abstained: false, choice: hypothesis('contradicts'), margin: 0.3, confidence: 0.6 })
      .mockResolvedValue({ ok: true, abstained: true, margin: 0.02, choice: null });

    const result = await score();
    // A `contradicts` buried behind a wide `aligned` is the single most useful
    // thing this feature can say; ranking by margin alone would bury it.
    expect(result.verdict).toBe('contradicts');
    expect(result.clauseId).toMatch(/^(PRD|GOALS)\.md#/);
    expect(result.advisory).toContain('works against');
    expect(result.advisory).toContain('Not a gate');
  });

  it('surfaces an unavailable scorer as itself rather than silently reporting no finding', async () => {
    decide.mockResolvedValue({ ok: false, code: 'jev-not-installed' });
    expect(await score()).toEqual({ ok: false, code: 'jev-not-installed' });
  });

  it('refuses a checkout with no product documents instead of grading it against this install\'s PRD', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'portos-scope-empty-'));
    expect(await score({ repoPath: empty })).toEqual({ ok: false, code: 'scope-adherence-corpus-missing' });
    expect(await score({ repoPath: '' })).toEqual({ ok: false, code: 'scope-adherence-corpus-missing' });
    expect(decide).not.toHaveBeenCalled();
    await rm(empty, { recursive: true, force: true });
  });

  it('rereads the corpus after the product documents change on disk', async () => {
    const first = await loadClauseCorpus(repoPath);
    await writeFile(join(repoPath, 'PRD.md'), `${PRD}\n## Added\n\nA newly stated requirement that did not exist a moment ago.\n`);
    const second = await loadClauseCorpus(repoPath);
    expect(second.clauses.length).toBe(first.clauses.length + 1);
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
    decide.mockResolvedValue({ ok: true, abstained: false, choice: hypothesis('contradicts'), margin: 0.8, confidence: 0.9 });
    const result = await score();
    expect(Object.keys(result).sort()).toEqual(['advisory', 'clause', 'clauseId', 'margin', 'ok', 'scored', 'verdict']);
  });

  it('keeps every scope-adherence module free of write, label, and task-spawn calls', async () => {
    // The acceptance criterion "no write path acts on the verdict", enforced
    // where a regression would actually appear: the day someone adds
    // `gh issue close` or a label write here, this fails. ETHOS.md treats the
    // absence of a gate as the feature, not an omission.
    const root = join(import.meta.dirname, '..');
    const sources = await Promise.all([
      readFile(join(root, 'services', 'scopeAdherence.js'), 'utf8'),
      readFile(join(root, 'lib', 'scopeAdherence.js'), 'utf8'),
      readFile(join(root, 'routes', 'apps', 'scopeAdherence.js'), 'utf8'),
    ]);
    const forbidden = /\b(writeFile|atomicWrite|createCachedStore|addLabel|add-label|issue close|createTask|addTask|spawnAgent)\b/;
    for (const source of sources) {
      // Comments narrate what the feature refuses to do, so only real code lines count.
      const code = source.split('\n').filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line)).join('\n');
      expect(code).not.toMatch(forbidden);
    }
  });
});
