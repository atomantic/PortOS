/**
 * visualStageHelpers.appearances.test.js
 *
 * assertCharacterAppearancesResolve request-boundary guard. Split from visualStages.test.js (#16214); shared mocks and state live in
 * visualStages.testFixtures.js.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// vi.mock factories are hoisted above imports; the shared fixtures module is
// loaded the same way.
const h = await vi.hoisted(() => import('./visualStages.testFixtures.js'));

vi.mock('./issues.js', () => h.issuesFactory());
vi.mock('./series.js', () => h.seriesFactory());
vi.mock('../settings.js', () => h.settingsFactory());
vi.mock('../universeBuilder.js', () => h.universeBuilderFactory());
vi.mock('../mediaJobQueue/index.js', () => h.mediaJobQueueFactory());
vi.mock('../stageRunner.js', () => h.stageRunnerFactory());
vi.mock('../../lib/mediaModels.js', () => h.mediaModelsFactory());
vi.mock('../characterLoraResolver.js', () => h.characterLoraResolverFactory());

const {
  assertCharacterAppearancesResolve,
} = await import('./visualStages.js');

beforeEach(() => {
  h.resetMocks();
});

describe('assertCharacterAppearancesResolve', () => {
  const characters = [
    { id: 'char-aria', name: 'Aria', wardrobes: [{ id: 'wd-coat', name: 'Trench coat' }] },
    { id: 'char-kessa', name: 'Kessa', wardrobes: [] },
  ];

  it('is a no-op for absent / empty / non-array picks', () => {
    expect(() => assertCharacterAppearancesResolve(undefined, characters)).not.toThrow();
    expect(() => assertCharacterAppearancesResolve([], characters)).not.toThrow();
    expect(() => assertCharacterAppearancesResolve(null, characters)).not.toThrow();
    expect(() => assertCharacterAppearancesResolve('nope', characters)).not.toThrow();
  });

  it('accepts a resolvable character + wardrobe pick', () => {
    expect(() => assertCharacterAppearancesResolve(
      [{ characterId: 'char-aria', wardrobeId: 'wd-coat' }],
      characters,
    )).not.toThrow();
  });

  it('accepts a character pick with no wardrobeId (canonical body description)', () => {
    expect(() => assertCharacterAppearancesResolve([{ characterId: 'char-aria' }], characters)).not.toThrow();
    expect(() => assertCharacterAppearancesResolve([{ characterId: 'char-kessa', wardrobeId: null }], characters)).not.toThrow();
  });

  it('400s on a dangling characterId', () => {
    expect(() => assertCharacterAppearancesResolve([{ characterId: 'char-ghost' }], characters))
      .toThrow(expect.objectContaining({ status: 400, code: 'PIPELINE_VISUAL_BAD_CHARACTER' }));
  });

  it('400s on a wardrobeId that does not belong to the character', () => {
    expect(() => assertCharacterAppearancesResolve(
      [{ characterId: 'char-kessa', wardrobeId: 'wd-coat' }],
      characters,
    )).toThrow(expect.objectContaining({ status: 400, code: 'PIPELINE_VISUAL_BAD_WARDROBE' }));
  });

  it('validates every pick, not just the first', () => {
    expect(() => assertCharacterAppearancesResolve(
      [{ characterId: 'char-aria', wardrobeId: 'wd-coat' }, { characterId: 'char-ghost' }],
      characters,
    )).toThrow(expect.objectContaining({ code: 'PIPELINE_VISUAL_BAD_CHARACTER' }));
  });

  it('tolerates empty canon and malformed picks without a wardrobeId', () => {
    expect(() => assertCharacterAppearancesResolve([{ characterId: 'char-aria' }], []))
      .toThrow(expect.objectContaining({ code: 'PIPELINE_VISUAL_BAD_CHARACTER' }));
    // A pick missing characterId entirely is skipped (the Zod schema guarantees
    // it upstream; the helper just doesn't crash on it).
    expect(() => assertCharacterAppearancesResolve([{ wardrobeId: 'wd-coat' }], characters)).not.toThrow();
  });
});

// Guards the WIRING (not just the pure helper): removing the
// assertCharacterAppearancesResolve call from enqueueVisualImage must turn
// these red, otherwise the request-boundary contract could silently regress.
