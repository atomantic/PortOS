import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockNoPeerSync, mockNoPeers } from '../../lib/mockPathsDataRoot.js';

// File-backed store so real series/issues run in-memory (mirrors autopilot test).
const fileStore = new Map();
vi.mock('../../lib/fileUtils.js', () => ({
  tryReadFile: vi.fn().mockResolvedValue(null),
  PATHS: { data: '/mock/data', cos: '/mock/data/cos' },
  ensureDir: vi.fn().mockResolvedValue(undefined),
  atomicWrite: vi.fn(async (path, data) => { fileStore.set(path, data); }),
  readJSONFile: vi.fn(async (path, fallback) => (fileStore.has(path) ? fileStore.get(path) : fallback)),
}));
vi.mock('../instances.js', () => mockNoPeers());
vi.mock('../sharing/peerSync.js', () => mockNoPeerSync());

// Control the canon returned for a series without standing up a real universe.
let canon = { characters: [], places: [], objects: [] };
vi.mock('./seriesCanon.js', () => ({ getSeriesCanon: vi.fn(async () => canon) }));

const seriesSvc = await import('./series.js');
const issuesSvc = await import('./issues.js');
const readiness = await import('./canonReadiness.js');
const { gradeCanonDescription, gradeReferencedNouns, checkIssueCanonReadiness, checkSeriesCanonReadiness } = readiness;

const charDescOf = (e) => e.physicalDescription || e.description || '';

beforeEach(() => {
  fileStore.clear();
  canon = { characters: [], places: [], objects: [] };
  vi.clearAllMocks();
});

describe('gradeCanonDescription (pure)', () => {
  it('grades none / thin / sufficient by description presence + length', () => {
    expect(gradeCanonDescription(charDescOf, { physicalDescription: '' })).toBe('none');
    expect(gradeCanonDescription(charDescOf, { physicalDescription: '   ' })).toBe('none');
    expect(gradeCanonDescription(charDescOf, { physicalDescription: 'tall, red hair' })).toBe('thin');
    expect(gradeCanonDescription(charDescOf, {
      physicalDescription: 'A tall woman with close-cropped silver hair, a scar over her left eye, and a long grey coat.',
    })).toBe('sufficient');
  });

  it('falls back from physicalDescription to description for characters', () => {
    expect(gradeCanonDescription(charDescOf, { description: 'A tall woman with a long grey weathered coat and boots.' })).toBe('sufficient');
  });
});

describe('gradeReferencedNouns (pure)', () => {
  const canonFixture = {
    characters: [
      { id: 'c1', name: 'Maggie', physicalDescription: 'A wiry hacker in a hoodie with restless hands and tired eyes.' },
      { id: 'c2', name: 'Kai', physicalDescription: '' }, // off-page, never described
    ],
    places: [{ id: 'p1', name: 'The Vault', description: '' }],
    objects: [{ id: 'o1', name: 'the backdoor', description: '' }],
  };

  it('flags referenced-but-undescribed nouns as `none` and ready=false', () => {
    const text = 'Maggie opens the backdoor inside The Vault.';
    const out = gradeReferencedNouns(text, canonFixture);
    expect(out.ready).toBe(false);
    const noneIds = out.none.map((n) => n.id).sort();
    expect(noneIds).toEqual(['o1', 'p1']); // The Vault + the backdoor
    expect(out.none.find((n) => n.id === 'p1')).toMatchObject({ name: 'The Vault', kind: 'place' });
  });

  it('does NOT flag a noun that is never referenced in the text (off-page Kai)', () => {
    // Kai is undescribed but absent from THIS panel text → not a blocker here.
    const text = 'Maggie types at her terminal.';
    const out = gradeReferencedNouns(text, {
      characters: [canonFixture.characters[0], canonFixture.characters[1]],
      places: [], objects: [],
    });
    expect(out.none).toHaveLength(0);
    expect(out.ready).toBe(true);
  });

  it('is ready when every referenced noun is described', () => {
    const text = 'Maggie types.';
    const out = gradeReferencedNouns(text, { characters: [canonFixture.characters[0]], places: [], objects: [] });
    expect(out.ready).toBe(true);
    expect(out.referenced).toBe(1);
  });

  it('returns ready for empty text', () => {
    expect(gradeReferencedNouns('', canonFixture).ready).toBe(true);
  });
});

describe('checkIssueCanonReadiness (matches the visual source)', () => {
  async function seedIssue({ comicScript, prose }) {
    const series = await seriesSvc.createSeries({ name: 'S', logline: 'L', premise: 'P', targetFormat: 'comic' });
    const issue = await issuesSvc.createIssue({ seriesId: series.id, title: 'I1', number: 1 });
    if (comicScript) await issuesSvc.updateStage(issue.id, 'comicScript', { status: 'ready', output: comicScript });
    if (prose) await issuesSvc.updateStage(issue.id, 'prose', { status: 'ready', output: prose });
    return issue.id;
  }

  it('flags a character drawn in a panel but undescribed', async () => {
    canon = { characters: [{ id: 'c1', name: 'Aria', physicalDescription: '' }], places: [], objects: [] };
    const issueId = await seedIssue({ comicScript: 'PAGE 1\nPANEL 1\nAria stands in the doorway.' });
    const report = await checkIssueCanonReadiness(issueId);
    expect(report.ready).toBe(false);
    expect(report.none.map((n) => n.name)).toContain('Aria');
  });

  it('does not flag a character named only in dialogue body (not drawn)', async () => {
    canon = { characters: [
      { id: 'c1', name: 'Maggie', physicalDescription: '' },
      { id: 'c2', name: 'Kai', physicalDescription: '' },
    ], places: [], objects: [] };
    const issueId = await seedIssue({ comicScript: 'PAGE 1\nPANEL 1\nMaggie sits alone at her terminal.\nMAGGIE: Kai called about the backdoor.' });
    const report = await checkIssueCanonReadiness(issueId);
    const names = report.none.map((n) => n.name);
    expect(names).toContain('Maggie'); // drawn (in action + speaks) and undescribed
    expect(names).not.toContain('Kai'); // only named inside dialogue body → not drawn
  });

  it('flags a character who speaks a line (drawn) when undescribed', async () => {
    canon = { characters: [{ id: 'c1', name: 'Kai', physicalDescription: '' }], places: [], objects: [] };
    const issueId = await seedIssue({ comicScript: 'PAGE 1\nPANEL 1\nTwo figures in shadow.\nKAI: I built it.' });
    const report = await checkIssueCanonReadiness(issueId);
    expect(report.none.map((n) => n.name)).toContain('Kai');
  });

  it('matches a speaker even with a dialogue modifier (KAI (WHISPERED): …)', async () => {
    canon = { characters: [{ id: 'c1', name: 'Kai', physicalDescription: '' }], places: [], objects: [] };
    const issueId = await seedIssue({ comicScript: 'PAGE 1\nPANEL 1\nTwo figures in shadow.\nKAI (WHISPERED): I built it.' });
    const report = await checkIssueCanonReadiness(issueId);
    expect(report.none.map((n) => n.name)).toContain('Kai');
  });

  it('does NOT flag an off-page character (in prose only, not in panels)', async () => {
    // Aria appears only in prose narration, never in the comic-script panels.
    canon = { characters: [{ id: 'c1', name: 'Aria', physicalDescription: '' }], places: [], objects: [] };
    const issueId = await seedIssue({
      comicScript: 'PAGE 1\nPANEL 1\nA dark server room, no one in frame.',
      prose: 'Maggie thought about Aria, who had built the backdoor years ago.',
    });
    const report = await checkIssueCanonReadiness(issueId);
    expect(report.ready).toBe(true); // Aria never drawn → not a visual blocker
  });
});

describe('checkSeriesCanonReadiness (roll-up)', () => {
  it('aggregates undescribed drawn nouns across issues', async () => {
    canon = { characters: [{ id: 'c1', name: 'Aria', physicalDescription: '' }], places: [], objects: [] };
    const series = await seriesSvc.createSeries({ name: 'S', logline: 'L', premise: 'P', targetFormat: 'comic' });
    const i1 = await issuesSvc.createIssue({ seriesId: series.id, title: 'I1', number: 1 });
    await issuesSvc.updateStage(i1.id, 'comicScript', { status: 'ready', output: 'PAGE 1\nPANEL 1\nAria enters.' });
    const report = await checkSeriesCanonReadiness(series.id);
    expect(report.ready).toBe(false);
    expect(report.undescribed.map((n) => n.name)).toContain('Aria');
    expect(report.blockingIssues).toHaveLength(1);
  });
});
