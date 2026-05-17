import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, unlinkSync, existsSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Create the tempRoot at top-level so PATHS.data resolves before any
// service module runs its `const STATE_PATH = join(PATHS.data, ...)` at
// import time. universeBuilder.js reads PATHS.data eagerly at module init,
// so a per-test `let tempRoot = mkdtempSync()` would land too late.
//
// Vitest module-scoping caveat: this mock is sticky for the entire worker
// — every service this file imports (universeBuilder, series, issues)
// captures the redirected PATHS at THEIR module init. Any other test file
// loaded by the same Vitest worker that imports those same services will
// inherit our redirected PATHS through the shared module cache. Vitest's
// default `pool: 'forks'` isolates by-file so this is safe today; if the
// project ever switches to `pool: 'threads'` with shared module caches,
// this file should be wrapped in `vi.isolate()` or moved into its own
// project to avoid cross-test PATHS leakage.
const tempRoot = mkdtempSync(join(tmpdir(), 'importer-test-'));

// Mock fileUtils.js so every PATHS member points under tempRoot — not
// just `data`. The importer's transitive imports (universeBuilder,
// series, issues, runner) only touch PATHS.data today, but if a future
// change starts writing under PATHS.logs / PATHS.runs / PATHS.cache,
// those writes would leak into the developer's working tree under the
// previous "override data only" pattern. Redirecting every key keeps
// tests hermetic regardless of which PATHS member the SUT picks up.
//
// Spread the actual exports into a plain object — matches the pattern
// used by bibleExtractor.test.js + sceneExtractor.test.js. A Proxy over
// the ESM namespace exotic object that `vi.importActual` returns is
// brittle: it intercepts only `get`, can bypass `[[Module]]` invariants
// Vitest's transform expects, and behaves unpredictably for
// `Symbol.toStringTag` / re-exports.
vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  const redirectedPaths = Object.fromEntries(
    Object.keys(actual.PATHS).map((k) => [k, join(tempRoot, k)]),
  );
  return {
    ...actual,
    PATHS: redirectedPaths,
  };
});

// Mock runStagedLLM so tests never hit a real provider — every importer
// LLM call resolves to a canned JSON shape we control per-test.
const mockRunStagedLLM = vi.fn();
vi.mock('../lib/stageRunner.js', () => ({
  runStagedLLM: (...args) => mockRunStagedLLM(...args),
}));

// Mock `./pipeline/issues.js` so a single test can force `createIssue` to
// throw mid-loop and exercise the ERR_PARTIAL_COMMIT_ISSUES rollback path.
// `vi.hoisted` keeps the mock fn ref reachable from both the mock factory
// (hoisted before imports) and the beforeEach reset (runs later). Default
// behavior passes through to the real module so the dozen other tests that
// expect real createIssue behavior keep working unchanged.
const { mockCreateIssue, realIssuesRef } = vi.hoisted(() => ({
  mockCreateIssue: vi.fn(),
  realIssuesRef: { current: null },
}));
vi.mock('./pipeline/issues.js', async () => {
  const actual = await vi.importActual('./pipeline/issues.js');
  realIssuesRef.current = actual;
  return {
    ...actual,
    createIssue: (...args) => mockCreateIssue(...args),
  };
});

const importerSvc = await import('./importer.js');
const universeSvc = await import('./universeBuilder.js');
const seriesSvc = await import('./pipeline/series.js');
const issuesSvc = await import('./pipeline/issues.js');

// Per-test: wipe every file under tempRoot so each test starts with a clean
// data dir. We can't rmSync the dir itself because the universeBuilder
// state path is captured at module init.
function wipeTempRoot() {
  for (const entry of readdirSync(tempRoot)) {
    const full = join(tempRoot, entry);
    const stat = statSync(full);
    if (stat.isFile()) unlinkSync(full);
    else rmSync(full, { recursive: true, force: true });
  }
}

beforeEach(() => {
  wipeTempRoot();
  mockRunStagedLLM.mockReset();
  // Default createIssue to pass-through to the real module — only the
  // rollback test overrides this to inject a mid-loop throw.
  mockCreateIssue.mockReset();
  mockCreateIssue.mockImplementation((...args) => realIssuesRef.current.createIssue(...args));
});

afterAll(() => {
  if (existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// findOrCreate helpers
// ---------------------------------------------------------------------------

describe('findUniverseByName', () => {
  it('returns null when no universe matches', async () => {
    expect(await importerSvc.findUniverseByName('Unknown')).toBeNull();
  });

  it('matches case-insensitively', async () => {
    const made = await universeSvc.createUniverse({ name: 'Cyberpunk 2099' });
    const found = await importerSvc.findUniverseByName('CYBERPUNK 2099');
    expect(found).not.toBeNull();
    expect(found.id).toBe(made.id);
  });
});

describe('findSeriesByName', () => {
  it('scopes the match to a universe', async () => {
    const uniA = await universeSvc.createUniverse({ name: 'Universe A' });
    const uniB = await universeSvc.createUniverse({ name: 'Universe B' });
    await seriesSvc.createSeries({ name: 'Same Title', universeId: uniA.id });

    // Match in universe A works.
    const foundInA = await importerSvc.findSeriesByName('SAME TITLE', uniA.id);
    expect(foundInA).not.toBeNull();
    expect(foundInA.universeId).toBe(uniA.id);

    // Same name in a different universe is NOT a match.
    const foundInB = await importerSvc.findSeriesByName('Same Title', uniB.id);
    expect(foundInB).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// analyzeImport
// ---------------------------------------------------------------------------

const canonRunResponse = {
  characters: [
    { name: 'Aria', role: 'protagonist', physicalDescription: 'tall, freckles' },
  ],
  places: [
    { name: 'The Foundry', slugline: 'INT. FOUNDRY — NIGHT', description: 'molten light' },
  ],
  objects: [
    { name: 'The Locket', description: 'silver, dented', significance: "mother's keepsake" },
  ],
};

const arcRunResponse = {
  logline: 'A blacksmith chases a hidden inheritance.',
  summary: 'Aria leaves the foundry to find her mother\'s past.',
  protagonistArc: 'Reluctant heir grows into reluctant leader.',
  themes: ['legacy', 'craft'],
  shape: 'man-in-hole',
  seasons: [
    { number: 1, title: 'Foundry', logline: 'Aria leaves home.', synopsis: 'opening', endingHook: '' },
  ],
};

const issuesRunResponse = {
  issues: [
    {
      title: 'Cold Iron',
      arcPosition: 1,
      arcRole: 'pilot',
      logline: 'The forge dies.',
      synopsis: 'Aria finds the letter.',
      proseExcerpt: 'The vault loomed in the dark.',
    },
  ],
};

function wireDefaultLLMResponses() {
  // Mock per-stage so the call order doesn't matter — important because
  // analyze fires canon + arc in parallel.
  mockRunStagedLLM.mockImplementation(async (stageName) => {
    if (stageName === 'importer-canon-extract') {
      return { content: canonRunResponse, model: 'mock', providerId: 'mock', runId: 'run-canon' };
    }
    if (stageName === 'importer-arc-extract') {
      return { content: arcRunResponse, model: 'mock', providerId: 'mock', runId: 'run-arc' };
    }
    if (stageName === 'importer-issue-proposal') {
      return { content: issuesRunResponse, model: 'mock', providerId: 'mock', runId: 'run-issues' };
    }
    throw new Error(`Unexpected stage: ${stageName}`);
  });
}

describe('analyzeImport', () => {
  it('creates universe + series on first run and returns preview shape', async () => {
    wireDefaultLLMResponses();

    const result = await importerSvc.analyzeImport({
      universeName: 'Test Universe',
      seriesName: 'Test Series',
      contentType: 'short-story',
      source: 'The vault loomed in the dark.',
    });

    expect(result.isExistingUniverse).toBe(false);
    expect(result.isExistingSeries).toBe(false);
    expect(result.universe.id).toBeDefined();
    expect(result.series.id).toMatch(/^ser-/);
    expect(result.series.universeId).toBe(result.universe.id);
    expect(result.canonPreview.characters).toHaveLength(1);
    expect(result.canonPreview.characters[0].name).toBe('Aria');
    expect(result.canonPreview.places).toHaveLength(1);
    expect(result.canonPreview.objects).toHaveLength(1);
    expect(result.arcPreview.shape).toBe('man-in-hole');
    expect(result.seasonsPreview).toHaveLength(1);
    expect(result.issueProposals).toHaveLength(1);
    expect(result.runIds).toEqual({ canon: 'run-canon', arc: 'run-arc', issues: 'run-issues' });
  });

  it('reuses existing universe + series on a second analyze with same names', async () => {
    wireDefaultLLMResponses();
    const first = await importerSvc.analyzeImport({
      universeName: 'Test U',
      seriesName: 'Test S',
      contentType: 'short-story',
      source: 'first',
    });
    const second = await importerSvc.analyzeImport({
      universeName: 'TEST U',  // case-insensitive
      seriesName: 'test s',
      contentType: 'short-story',
      source: 'second',
    });
    expect(second.isExistingUniverse).toBe(true);
    expect(second.isExistingSeries).toBe(true);
    expect(second.universe.id).toBe(first.universe.id);
    expect(second.series.id).toBe(first.series.id);
  });

  it('rejects oversized source with ERR_VALIDATION before calling the LLM', async () => {
    wireDefaultLLMResponses();
    let caught;
    try {
      await importerSvc.analyzeImport({
        universeName: 'U',
        seriesName: 'S',
        contentType: 'novel',
        source: 'x'.repeat(importerSvc.IMPORTER_SOURCE_CHAR_LIMIT + 1),
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe(importerSvc.ERR_VALIDATION);
    expect(mockRunStagedLLM).not.toHaveBeenCalled();
  });

  it('passes returnsJson:true so the stage runner parses the LLM reply', async () => {
    // Regression-pin: without `returnsJson: true`, runStagedLLM returns the
    // raw text and the orchestrator's `Array.isArray(content?.field)` checks
    // all silently fail (preview becomes empty). Lock the opt in by asserting
    // every analyze stage call passes it.
    wireDefaultLLMResponses();
    await importerSvc.analyzeImport({
      universeName: 'U', seriesName: 'S', contentType: 'short-story', source: 'x',
    });
    expect(mockRunStagedLLM).toHaveBeenCalled();
    for (const call of mockRunStagedLLM.mock.calls) {
      const opts = call[2];
      expect(opts).toMatchObject({ returnsJson: true });
    }
  });

  it('forwards Mustache section-guard flags so per-content-type prompt blocks render', async () => {
    // Regression-pin: PortOS's template engine is Mustache-only — the prompts
    // use `{{#isShortStory}}…{{/isShortStory}}` blocks, so the orchestrator
    // must pass per-type booleans alongside the contentType string.
    wireDefaultLLMResponses();
    await importerSvc.analyzeImport({
      universeName: 'U', seriesName: 'S', contentType: 'novel', source: 'x',
    });
    const firstVars = mockRunStagedLLM.mock.calls[0][1];
    expect(firstVars).toMatchObject({
      isNovel: true,
      isShortStory: false,
      isScreenplay: false,
      isComicScript: false,
    });
  });

  it('rejects a locked-arc series with ERR_LOCKED before calling the LLM', async () => {
    // Pre-seed a series with locked.arc, then re-analyze with its name.
    const uni = await universeSvc.createUniverse({ name: 'Locked U' });
    const seeded = await seriesSvc.createSeries({ name: 'Locked S', universeId: uni.id });
    await seriesSvc.updateSeries(seeded.id, { locked: { arc: true } });

    wireDefaultLLMResponses();
    let caught;
    try {
      await importerSvc.analyzeImport({
        universeName: 'Locked U',
        seriesName: 'Locked S',
        contentType: 'short-story',
        source: 'anything',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe(importerSvc.ERR_LOCKED);
    expect(mockRunStagedLLM).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// commitImport
// ---------------------------------------------------------------------------

async function setupForCommit() {
  // Create the universe + series the analyze phase would have created, then
  // exercise commitImport directly with a hand-shaped payload.
  const uni = await universeSvc.createUniverse({ name: 'Commit U' });
  const ser = await seriesSvc.createSeries({ name: 'Commit S', universeId: uni.id });
  return { uni, ser };
}

describe('commitImport', () => {
  it('happy path: merges canon, writes arc + seasons, creates issues with prose seeded', async () => {
    const { uni, ser } = await setupForCommit();
    const result = await importerSvc.commitImport({
      universeId: uni.id,
      seriesId: ser.id,
      canonSelections: {
        characters: [{ name: 'Aria', role: 'protagonist', physicalDescription: 'tall' }],
        places: [{ name: 'The Foundry', slugline: 'INT. FOUNDRY — NIGHT', description: 'molten' }],
        objects: [{ name: 'The Locket', significance: 'heirloom' }],
      },
      arc: {
        logline: 'A reluctant heir.',
        summary: 'Big story.',
        protagonistArc: 'Growth.',
        themes: ['legacy'],
        shape: 'man-in-hole',
      },
      seasons: [
        { number: 1, title: 'Foundry', logline: 'Open', synopsis: 'a', endingHook: '' },
      ],
      issues: [
        {
          title: 'Cold Iron',
          arcPosition: 1,
          arcRole: 'pilot',
          logline: 'Forge dies.',
          synopsis: 'Aria finds the letter.',
          proseExcerpt: 'The vault loomed in the dark.',
        },
      ],
    });

    // Universe canon was merged.
    expect(result.universe.characters.find((c) => c.name === 'Aria')).toBeDefined();
    expect(result.universe.settings.find((s) => s.name === 'The Foundry')).toBeDefined();
    expect(result.universe.objects.find((o) => o.name === 'The Locket')).toBeDefined();
    // Series got arc + seasons.
    expect(result.series.arc.shape).toBe('man-in-hole');
    expect(result.series.seasons).toHaveLength(1);
    expect(result.series.seasons[0].title).toBe('Foundry');
    // One issue created with prose + idea seeded.
    expect(result.createdIssueIds).toHaveLength(1);
    const issue = await issuesSvc.getIssue(result.createdIssueIds[0]);
    expect(issue.title).toBe('Cold Iron');
    expect(issue.seriesId).toBe(ser.id);
    expect(issue.stages.prose.output).toBe('The vault loomed in the dark.');
    expect(issue.stages.prose.status).toBe('ready');
    expect(issue.stages.idea.input).toContain('Logline: Forge dies.');
    expect(issue.stages.idea.input).toContain('Synopsis: Aria finds the letter.');
    // Issue was wired to the first season.
    expect(issue.seasonId).toBe(result.series.seasons[0].id);
  });

  it('refuses to commit when the series arc is locked', async () => {
    const { uni, ser } = await setupForCommit();
    await seriesSvc.updateSeries(ser.id, { locked: { arc: true } });
    let caught;
    try {
      await importerSvc.commitImport({
        universeId: uni.id,
        seriesId: ser.id,
        canonSelections: { characters: [], places: [], objects: [] },
        arc: { logline: 'x', summary: 'y' },
        seasons: [],
        issues: [{ title: 'I1', arcPosition: 1, proseExcerpt: 'p' }],
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe(importerSvc.ERR_LOCKED);
    // No issues were created.
    const issuesAfter = await issuesSvc.listIssues({ seriesId: ser.id });
    expect(issuesAfter).toHaveLength(0);
  });

  it('LWW-merges canon by name — second commit does not duplicate a known character', async () => {
    const { uni, ser } = await setupForCommit();
    // Seed Aria once.
    await importerSvc.commitImport({
      universeId: uni.id,
      seriesId: ser.id,
      canonSelections: {
        characters: [{ name: 'Aria', role: 'protagonist', physicalDescription: 'tall' }],
        places: [],
        objects: [],
      },
      arc: null,
      seasons: [],
      issues: [{ title: 'I1', arcPosition: 1, proseExcerpt: 'p1' }],
    });
    // Commit a second pass with Aria again (different case + no description
    // to exercise the userEditable-blank rule).
    const second = await importerSvc.commitImport({
      universeId: uni.id,
      seriesId: ser.id,
      canonSelections: {
        characters: [{ name: 'ARIA', role: 'protagonist' }],
        places: [],
        objects: [],
      },
      arc: null,
      seasons: [],
      issues: [{ title: 'I2', arcPosition: 2, proseExcerpt: 'p2' }],
    });
    const ariaEntries = second.universe.characters.filter((c) => c.name.toLowerCase() === 'aria');
    expect(ariaEntries).toHaveLength(1);
    // Original physicalDescription preserved (mergeExtractedBible doesn't
    // overwrite non-blank userEditable fields).
    expect(ariaEntries[0].physicalDescription).toBe('tall');
  });

  it('refuses commit when the issues array is empty', async () => {
    const { uni, ser } = await setupForCommit();
    let caught;
    try {
      await importerSvc.commitImport({
        universeId: uni.id,
        seriesId: ser.id,
        canonSelections: { characters: [], places: [], objects: [] },
        arc: null,
        seasons: [],
        issues: [],
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe(importerSvc.ERR_VALIDATION);
  });

  it('refuses commit when at least one issue in the array is missing a title', async () => {
    // Exercises the per-entry title validation loop (importer.js lines 315-323).
    // A non-empty issues array where one entry has no title must be rejected
    // fail-fast, before any state is written to disk.
    const { uni, ser } = await setupForCommit();
    let caught;
    try {
      await importerSvc.commitImport({
        universeId: uni.id,
        seriesId: ser.id,
        canonSelections: { characters: [], places: [], objects: [] },
        arc: null,
        seasons: [],
        issues: [
          { title: 'Valid Issue', arcPosition: 1, proseExcerpt: 'p1' },
          { title: '', arcPosition: 2, proseExcerpt: 'p2' },
        ],
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe(importerSvc.ERR_VALIDATION);
    expect(caught.message).toMatch(/position 2/i);
    // Confirm no issues were created — the fail-fast guard prevented any write.
    const issuesAfter = await issuesSvc.listIssues({ seriesId: ser.id });
    expect(issuesAfter).toHaveLength(0);
  });

  it('second-pass seasons are MERGED into existing seasons, not replaced', async () => {
    // Regression guard for importer.js:360 destructive-replace behavior.
    // Both passes supply non-empty seasons arrays; after the second commit the
    // series must contain seasons from BOTH calls (merge), not just the second.
    //
    // NOTE: this test asserts the intended post-fix MERGE behavior. If the
    // parallel agent's merge fix in importer.js has not landed yet, this test
    // will fail loudly — that is the correct signal.
    const { uni, ser } = await setupForCommit();

    // First pass: season 1.
    const first = await importerSvc.commitImport({
      universeId: uni.id,
      seriesId: ser.id,
      canonSelections: { characters: [], places: [], objects: [] },
      arc: null,
      seasons: [{ number: 1, title: 'Season One', logline: 'Beginning', synopsis: 'a', endingHook: '' }],
      issues: [{ title: 'I1', arcPosition: 1, proseExcerpt: 'p1' }],
    });
    expect(first.series.seasons).toHaveLength(1);
    expect(first.series.seasons[0].title).toBe('Season One');

    // Second pass: season 2 — the importer must MERGE this with season 1.
    const second = await importerSvc.commitImport({
      universeId: uni.id,
      seriesId: ser.id,
      canonSelections: { characters: [], places: [], objects: [] },
      arc: null,
      seasons: [{ number: 2, title: 'Season Two', logline: 'Escalation', synopsis: 'b', endingHook: '' }],
      issues: [{ title: 'I2', arcPosition: 2, proseExcerpt: 'p2' }],
    });

    // After merge: series must contain both seasons.
    expect(second.series.seasons).toHaveLength(2);
    const titles = second.series.seasons.map((s) => s.title);
    expect(titles).toContain('Season One');
    expect(titles).toContain('Season Two');
    // Season numbers must also be preserved correctly.
    const s1 = second.series.seasons.find((s) => s.number === 1);
    const s2 = second.series.seasons.find((s) => s.number === 2);
    expect(s1).toBeDefined();
    expect(s2).toBeDefined();
  });

  // Round-12 review: cross-universe guard must refuse commit when the
  // series has NO universeId (legacy / hand-edited data), not just when
  // it differs. Previously a falsy universeId silently bypassed the
  // guard and let the importer re-home the series.
  it('refuses commit when the series has no universeId', async () => {
    const uni = await universeSvc.createUniverse({ name: 'Linkless U' });
    const ser = await seriesSvc.createSeries({ name: 'Linkless S' });
    // sanitizeSeries normalizes a missing universeId to null. Confirm
    // the precondition before exercising the guard.
    expect(ser.universeId).toBeFalsy();
    let caught;
    try {
      await importerSvc.commitImport({
        universeId: uni.id, seriesId: ser.id,
        canonSelections: { characters: [], places: [], objects: [] },
        arc: null,
        seasons: [],
        issues: [{ title: 'I1', arcPosition: 1, proseExcerpt: 'p' }],
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe(importerSvc.ERR_VALIDATION);
    expect(caught.message).toMatch(/no universeId/i);
  });

  // Round-10 review: round-9's auto-assign fix only covered the omitted
  // case. An incoming issue that EXPLICITLY sets `arcPosition: 1` while
  // the series already holds an issue at position 1 must be rejected
  // fail-fast, not silently land a duplicate.
  it('refuses commit when an explicit arcPosition collides with an existing issue', async () => {
    const { uni, ser } = await setupForCommit();
    await importerSvc.commitImport({
      universeId: uni.id, seriesId: ser.id,
      canonSelections: { characters: [], places: [], objects: [] },
      arc: null,
      seasons: [],
      issues: [{ title: 'I1', arcPosition: 1, proseExcerpt: 'p1' }],
    });
    let caught;
    try {
      await importerSvc.commitImport({
        universeId: uni.id, seriesId: ser.id,
        canonSelections: { characters: [], places: [], objects: [] },
        arc: null,
        seasons: [],
        // Explicit arcPosition 1 — already used by I1 above.
        issues: [{ title: 'Collision', arcPosition: 1, proseExcerpt: 'p2' }],
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe(importerSvc.ERR_VALIDATION);
    expect(caught.message).toMatch(/collides with an existing issue/i);
    // No issue created — the gate fires before createIssue.
    const all = await issuesSvc.listIssues({ seriesId: ser.id });
    expect(all).toHaveLength(1);
  });

  // Round-9 review: arcPosition auto-assign must seed `nextFreeArcPos`
  // from the union of explicit incoming positions AND pre-existing
  // series.issues[].arcPosition — re-import on a series that already
  // has issues at [1..3] would otherwise auto-assign starting at 1 again
  // and create duplicate positions silently.
  it('arcPosition auto-assign on re-import skips arcPositions already used by existing issues', async () => {
    const { uni, ser } = await setupForCommit();
    // First pass: seed three issues at arcPositions 1, 2, 3.
    await importerSvc.commitImport({
      universeId: uni.id, seriesId: ser.id,
      canonSelections: { characters: [], places: [], objects: [] },
      arc: null,
      seasons: [],
      issues: [
        { title: 'I1', arcPosition: 1, proseExcerpt: 'p1' },
        { title: 'I2', arcPosition: 2, proseExcerpt: 'p2' },
        { title: 'I3', arcPosition: 3, proseExcerpt: 'p3' },
      ],
    });
    // Second pass: two new issues with NO arcPosition. Must auto-assign
    // to 4 and 5, not collide with 1 and 2.
    const second = await importerSvc.commitImport({
      universeId: uni.id, seriesId: ser.id,
      canonSelections: { characters: [], places: [], objects: [] },
      arc: null,
      seasons: [],
      issues: [
        { title: 'I4 — auto', proseExcerpt: 'p4' },
        { title: 'I5 — auto', proseExcerpt: 'p5' },
      ],
    });
    expect(second.createdIssueIds).toHaveLength(2);
    const i4 = await issuesSvc.getIssue(second.createdIssueIds[0]);
    const i5 = await issuesSvc.getIssue(second.createdIssueIds[1]);
    expect(i4.arcPosition).toBe(4);
    expect(i5.arcPosition).toBe(5);
    // And the full series now has 5 issues, no collisions on arcPosition.
    const allIssues = await issuesSvc.listIssues({ seriesId: ser.id });
    const positions = allIssues.map((i) => i.arcPosition).sort((a, b) => a - b);
    expect(positions).toEqual([1, 2, 3, 4, 5]);
  });

  // Round-8 review: fallbackSeasonId must pick the LOWEST-NUMBERED season,
  // not array-position [0]. After mergeSeasons the array order is
  // `[...retained, ...incomingBuilt]` — retained existing seasons come
  // first regardless of number, so a series with [season 2, season 3] that
  // receives a new season 1 would otherwise pick season 2 as "fallback".
  it('fallbackSeasonId picks the lowest-numbered season, not array[0]', async () => {
    const { uni, ser } = await setupForCommit();

    // First pass: seed seasons 2 and 3 (skip 1).
    await importerSvc.commitImport({
      universeId: uni.id, seriesId: ser.id,
      canonSelections: { characters: [], places: [], objects: [] },
      arc: null,
      seasons: [
        { number: 2, title: 'Two', logline: 'a', synopsis: '', endingHook: '' },
        { number: 3, title: 'Three', logline: 'b', synopsis: '', endingHook: '' },
      ],
      issues: [{ title: 'I1', arcPosition: 1, proseExcerpt: 'p1' }],
    });

    // Second pass: add season 1 + an issue with no seasonNumber. The
    // fallback must land it in season 1 (the new lowest), even though
    // mergeSeasons returns [retained_2, retained_3, new_1] in that order.
    const second = await importerSvc.commitImport({
      universeId: uni.id, seriesId: ser.id,
      canonSelections: { characters: [], places: [], objects: [] },
      arc: null,
      seasons: [{ number: 1, title: 'One', logline: 'c', synopsis: '', endingHook: '' }],
      issues: [{ title: 'I-no-season', arcPosition: 4, proseExcerpt: 'p4' }],
    });

    const created = await issuesSvc.getIssue(second.createdIssueIds[0]);
    const seasonOne = second.series.seasons.find((s) => s.number === 1);
    expect(seasonOne).toBeDefined();
    expect(created.seasonId).toBe(seasonOne.id);
  });

  // Round-8 review: remappedIssues entries now carry actualSeasonNumber
  // and actualSeasonTitle so the client toast can name the season
  // precisely instead of saying a generic "first season".
  it('remappedIssues entries carry actualSeasonNumber + actualSeasonTitle', async () => {
    const { uni, ser } = await setupForCommit();
    // Seed season 1 only; the next commit references a non-existent season 99
    // — the issue must land in season 1 and the remap entry must surface it.
    const result = await importerSvc.commitImport({
      universeId: uni.id, seriesId: ser.id,
      canonSelections: { characters: [], places: [], objects: [] },
      arc: null,
      seasons: [{ number: 1, title: 'Foundry', logline: 'open', synopsis: '', endingHook: '' }],
      issues: [
        { title: 'A', arcPosition: 1, seasonNumber: 99, proseExcerpt: 'pa' },
      ],
    });
    expect(result.remappedIssues).toHaveLength(1);
    const remap = result.remappedIssues[0];
    expect(remap.requestedSeasonNumber).toBe(99);
    expect(remap.actualSeasonNumber).toBe(1);
    expect(remap.actualSeasonTitle).toBe('Foundry');
    expect(remap.actualSeasonId).toBeDefined();
  });

  // Round-8 review: missing test for the ERR_PARTIAL_COMMIT_ISSUES rollback
  // path. Inject a createIssue failure on the 2nd of 3 issues; assert that
  // the rollback deletes the 1st (already created), surfaces the partial
  // code, and leaves the universe + series writes intact (those are
  // idempotent + user-confirmed, so we don't roll them back).
  it('rolls back created issues + throws ERR_PARTIAL_COMMIT_ISSUES when createIssue fails mid-loop', async () => {
    const { uni, ser } = await setupForCommit();
    let call = 0;
    mockCreateIssue.mockImplementation(async (...args) => {
      call++;
      if (call === 2) throw new Error('simulated mid-loop FS error');
      return realIssuesRef.current.createIssue(...args);
    });

    let caught;
    try {
      await importerSvc.commitImport({
        universeId: uni.id, seriesId: ser.id,
        canonSelections: { characters: [{ name: 'Aria' }], places: [], objects: [] },
        arc: { logline: 'A', summary: 'S', shape: 'man-in-hole' },
        seasons: [{ number: 1, title: 'S1', logline: '', synopsis: '', endingHook: '' }],
        issues: [
          { title: 'I1', arcPosition: 1, proseExcerpt: 'p1' },
          { title: 'I2', arcPosition: 2, proseExcerpt: 'p2' },
          { title: 'I3', arcPosition: 3, proseExcerpt: 'p3' },
        ],
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    expect(caught.code).toBe('IMPORTER_PARTIAL_COMMIT_ISSUES');
    expect(caught.message).toMatch(/universe and series were updated/i);
    expect(caught.message).toMatch(/simulated mid-loop FS error/);

    // Universe + series writes survive (user-confirmed, idempotent).
    const universeAfter = await universeSvc.getUniverse(uni.id);
    expect(universeAfter.characters.some((c) => c.name === 'Aria')).toBe(true);
    const seriesAfter = await seriesSvc.getSeries(ser.id);
    expect(seriesAfter.arc?.shape).toBe('man-in-hole');
    expect(seriesAfter.seasons).toHaveLength(1);

    // No leftover issues from the partial loop.
    const issuesAfter = await issuesSvc.listIssues({ seriesId: ser.id });
    expect(issuesAfter).toHaveLength(0);
  });
});

describe('mergeSeasons (pure helper)', () => {
  const stubBuildSeason = (input) => ({
    id: `built-${input.number}`,
    number: input.number,
    title: input.title,
    logline: input.logline,
    synopsis: input.synopsis,
    endingHook: input.endingHook,
    episodeCountTarget: input.episodeCountTarget,
    status: input.status,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  });

  it('auto-assigns sequential numbers when incoming seasons omit number', () => {
    const incoming = [
      { title: 'A' },
      { title: 'B' },
      { title: 'C' },
    ];
    const result = importerSvc.mergeSeasons([], incoming, stubBuildSeason);
    const numbers = result.map((s) => s.number).sort((a, b) => a - b);
    expect(numbers).toEqual([1, 2, 3]);
  });

  it('preserves existing ids when incoming season number matches', () => {
    const existing = [
      { id: 'existing-1', number: 1, title: 'Old', logline: '', synopsis: '', updatedAt: '2020-01-01T00:00:00.000Z' },
    ];
    const incoming = [{ number: 1, title: 'Old', logline: '', synopsis: '' }];
    const result = importerSvc.mergeSeasons(existing, incoming, stubBuildSeason);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('existing-1');
  });

  it('bumps updatedAt only when an importable field changes', () => {
    const existing = [
      { id: 'e1', number: 1, title: 'Original', logline: 'L1', synopsis: 'S1', updatedAt: '2020-01-01T00:00:00.000Z' },
    ];
    // No change → updatedAt preserved
    const noChange = importerSvc.mergeSeasons(existing, [{ number: 1, title: 'Original' }], stubBuildSeason);
    expect(noChange[0].updatedAt).toBe('2020-01-01T00:00:00.000Z');
    // Title change → updatedAt bumped (to a value newer than the original)
    const titleChange = importerSvc.mergeSeasons(existing, [{ number: 1, title: 'New title' }], stubBuildSeason);
    expect(titleChange[0].updatedAt > '2020-01-01T00:00:00.000Z').toBe(true);
  });

  it('retains existing seasons that the incoming list does not touch', () => {
    const existing = [
      { id: 'e1', number: 1, title: 'One', logline: '', synopsis: '' },
      { id: 'e2', number: 2, title: 'Two', logline: '', synopsis: '' },
    ];
    const incoming = [{ number: 1, title: 'One updated' }];
    const result = importerSvc.mergeSeasons(existing, incoming, stubBuildSeason);
    expect(result).toHaveLength(2);
    expect(result.find((s) => s.number === 2)?.id).toBe('e2');
  });

  it('skips over existing numbers when auto-assigning', () => {
    const existing = [
      { id: 'e1', number: 1, title: 'One', logline: '', synopsis: '' },
      { id: 'e2', number: 3, title: 'Three', logline: '', synopsis: '' },
    ];
    const incoming = [{ title: 'New A' }, { title: 'New B' }];
    const result = importerSvc.mergeSeasons(existing, incoming, stubBuildSeason);
    const newNumbers = result.filter((s) => s.id.startsWith('built-')).map((s) => s.number).sort((a, b) => a - b);
    // nextFree = max(1,3) + 1 = 4 → [4, 5]
    expect(newNumbers).toEqual([4, 5]);
  });

  // Round-7 review: distinguish absent-vs-empty per CLAUDE.md's "LLM
  // response merging" convention. An empty string is the user's intent
  // to clear the field; null/undefined is the LLM omitting it and the
  // existing value should win.
  it('absent string fields (null/undefined) preserve the existing value', () => {
    const existing = [
      { id: 'e1', number: 1, title: 'Kept', logline: 'L', synopsis: 'S', endingHook: 'H', updatedAt: '2020-01-01T00:00:00.000Z' },
    ];
    const incoming = [{ number: 1, title: undefined, logline: null }];
    const result = importerSvc.mergeSeasons(existing, incoming, stubBuildSeason);
    expect(result[0].title).toBe('Kept');
    expect(result[0].logline).toBe('L');
    // No change in any tracked field → updatedAt preserved
    expect(result[0].updatedAt).toBe('2020-01-01T00:00:00.000Z');
  });

  it('empty-string fields are treated as an intentional clear and bump updatedAt', () => {
    const existing = [
      { id: 'e1', number: 1, title: 'Original', logline: 'L', synopsis: 'S', endingHook: 'H', updatedAt: '2020-01-01T00:00:00.000Z' },
    ];
    const incoming = [{ number: 1, logline: '', synopsis: '' }];
    const result = importerSvc.mergeSeasons(existing, incoming, stubBuildSeason);
    expect(result[0].logline).toBe('');
    expect(result[0].synopsis).toBe('');
    // Title not present → preserved.
    expect(result[0].title).toBe('Original');
    // A clear is a change → updatedAt bumps.
    expect(result[0].updatedAt > '2020-01-01T00:00:00.000Z').toBe(true);
  });

  it('throws ERR_VALIDATION when auto-assign would exceed the season number cap (99)', () => {
    const existing = Array.from({ length: 99 }, (_, i) => ({
      id: `e${i + 1}`, number: i + 1, title: `S${i + 1}`, logline: '', synopsis: '',
    }));
    let caught;
    try {
      importerSvc.mergeSeasons(existing, [{ title: 'overflow' }], stubBuildSeason);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe(importerSvc.ERR_VALIDATION);
    expect(caught.message).toContain('99');
  });

  // Round-11 review: legacy seasons with `title: undefined` would
  // previously churn updatedAt on every no-op re-import — the change
  // check compared `'Season N'` (the default applied to the new value)
  // against `undefined` (the existing value), always producing a
  // truthy diff. Fix applies the same default to both sides of the
  // comparison so a re-import with no edits is correctly a no-op.
  it('does NOT bump updatedAt for a legacy season with undefined title and no incoming edit', () => {
    const existing = [
      { id: 'e1', number: 1, /* title: undefined */ logline: '', synopsis: '', updatedAt: '2020-01-01T00:00:00.000Z' },
    ];
    // Incoming season omits every editable field — pure no-op.
    const result = importerSvc.mergeSeasons(existing, [{ number: 1 }], stubBuildSeason);
    expect(result[0].updatedAt).toBe('2020-01-01T00:00:00.000Z');
  });

  // Round-8 review: the pure helper now rejects duplicate explicit incoming
  // numbers directly — commitImport's route gate caught this for HTTP
  // callers, but a future direct consumer would otherwise silently collapse
  // two entries sharing a number into one merge target.
  it('throws ERR_VALIDATION on duplicate explicit incoming season numbers', () => {
    let caught;
    try {
      importerSvc.mergeSeasons([], [
        { number: 1, title: 'A' },
        { number: 1, title: 'B' },
      ], stubBuildSeason);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe(importerSvc.ERR_VALIDATION);
    expect(caught.message).toMatch(/duplicate/i);
  });
});
