import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, unlinkSync, existsSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Create the tempRoot at top-level so PATHS.data resolves before any
// service module runs its `const STATE_PATH = join(PATHS.data, ...)` at
// import time. universeBuilder.js reads PATHS.data eagerly at module init,
// so a per-test `let tempRoot = mkdtempSync()` would land too late.
const tempRoot = mkdtempSync(join(tmpdir(), 'importer-test-'));

// Mock fileUtils.js to point PATHS.data at our test root. Spread the actual
// exports into a plain object and override PATHS — matches the pattern used
// by bibleExtractor.test.js + sceneExtractor.test.js. A Proxy over the ESM
// namespace exotic object that `vi.importActual` returns is brittle: it
// intercepts only `get`, can bypass `[[Module]]` invariants Vitest's transform
// expects, and behaves unpredictably for `Symbol.toStringTag` / re-exports.
vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return {
    ...actual,
    PATHS: { ...actual.PATHS, data: tempRoot },
  };
});

// Mock runStagedLLM so tests never hit a real provider — every importer
// LLM call resolves to a canned JSON shape we control per-test.
const mockRunStagedLLM = vi.fn();
vi.mock('../lib/stageRunner.js', () => ({
  runStagedLLM: (...args) => mockRunStagedLLM(...args),
}));

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
});
