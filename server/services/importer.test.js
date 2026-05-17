import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, unlinkSync, existsSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Create the tempRoot at top-level so PATHS.data resolves before any
// service module runs its `const STATE_PATH = join(PATHS.data, ...)` at
// import time. universeBuilder.js reads PATHS.data eagerly at module init,
// so a per-test `let tempRoot = mkdtempSync()` would land too late.
const tempRoot = mkdtempSync(join(tmpdir(), 'importer-test-'));

// Mock fileUtils.js to point PATHS.data at our test root. Proxy passes
// every other export through unchanged so atomicWrite / readJSONFile keep
// the real shapes.
vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return new Proxy(actual, {
    get(target, prop) {
      if (prop === 'PATHS') return { ...actual.PATHS, data: tempRoot };
      return target[prop];
    },
  });
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

  it('refuses commit when at least one issue is missing', async () => {
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
});
