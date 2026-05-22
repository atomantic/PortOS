import { describe, it, expect } from 'vitest';
import { buildCharacterReferenceSheetPrompt, REFERENCE_SHEET_CONSTANTS, resolveSheetModelId, listSheetVariants } from './universeCharacterSheet.js';

const baseUniverse = {
  id: 'u-123',
  name: 'Test Universe',
  influences: { embrace: ['neo-noir', 'coastal rain'] },
  styleNotes: 'painterly, ink-heavy, saturated cool palette',
};

const richCharacter = {
  id: 'c-456',
  name: 'Vale',
  aliases: ['Signal Runner'],
  age: '27',
  pronouns: 'she/her',
  role: 'protagonist',
  personality: 'alert, mischievous',
  speechAccent: 'contemporary Pacific Northwest',
  coreTheme: 'cartographer of grief',
  visualNotes: 'layered streetwear; faded mustard + charcoal',
  physicalDescription: 'short curly hair, amber eyes',
  silhouetteNotes: 'compact upper body; tapered lower half',
  postureNotes: 'slight forward lean',
  specialTraits: 'quick hands; chipped nail polish',
  visualIdentity: 'urban utilitarian; analog tech feel',
  stats: [
    { label: 'Height', value: "5'7\"" },
    { label: 'Eye color', value: 'amber' },
  ],
  colorPalette: [
    { name: 'amber', hex: '#f59e0b', role: 'skin' },
    { name: 'olive', hex: '#6b7c4d', role: 'jacket' },
  ],
  props: [
    { name: 'Radio', purpose: 'comms', materials: 'plastic + alloy' },
    { name: 'Map case', purpose: 'navigation', materials: 'canvas' },
  ],
  expressions: [
    { name: 'neutral', description: 'baseline' },
    { name: 'curious', description: 'eyes wide' },
  ],
  handGestures: [
    { name: 'pointing', description: 'index extended' },
    { name: 'gripping radio', description: 'fingers wrapped' },
  ],
  wardrobes: [
    { name: 'Field', description: 'olive jacket + boots' },
  ],
};

describe('universeCharacterSheet — buildCharacterReferenceSheetPrompt', () => {
  it('builds a multi-section prompt with all character zones', () => {
    const out = buildCharacterReferenceSheetPrompt(baseUniverse, richCharacter);
    expect(out.prompt.length).toBeGreaterThan(1500);
    expect(out.prompt).toContain('CHARACTER REFERENCE SHEET');
    expect(out.prompt).toContain('Vale');
    expect(out.prompt).toContain('Signal Runner');
    expect(out.prompt).toContain('she/her');
    // Universe style tokens flow into the preamble.
    expect(out.prompt).toContain('neo-noir');
    expect(out.prompt).toContain('coastal rain');
    expect(out.prompt).toContain('painterly');
    // Every named zone appears in the prompt.
    expect(out.prompt).toMatch(/FRONT view.*3\/4 view.*SIDE view.*BACK view/s);
    expect(out.prompt).toMatch(/Color palette zone/);
    expect(out.prompt).toMatch(/Expression progression/);
    expect(out.prompt).toMatch(/Head detail sheet/);
    expect(out.prompt).toMatch(/Wardrobe \/ accessories/);
    expect(out.prompt).toMatch(/Prop showcase/);
    expect(out.prompt).toMatch(/Hand gestures/);
    expect(out.prompt).toMatch(/Silhouette notes/);
    expect(out.prompt).toMatch(/Posture notes/);
    expect(out.prompt).toMatch(/Special traits/);
  });

  it('flattens palette swatches with hex + role', () => {
    const out = buildCharacterReferenceSheetPrompt(baseUniverse, richCharacter);
    expect(out.prompt).toContain('amber #f59e0b — skin');
    expect(out.prompt).toContain('olive #6b7c4d — jacket');
  });

  it('flattens props with purpose + materials', () => {
    const out = buildCharacterReferenceSheetPrompt(baseUniverse, richCharacter);
    expect(out.prompt).toContain('Radio (comms) [plastic + alloy]');
    expect(out.prompt).toContain('Map case (navigation) [canvas]');
  });

  it('flattens wardrobes as labeled cards', () => {
    const out = buildCharacterReferenceSheetPrompt(baseUniverse, richCharacter);
    expect(out.prompt).toContain('"Field": olive jacket + boots');
  });

  it('uses default expression and gesture lists when character has none', () => {
    const sparse = { id: 'c-1', name: 'Sparse', physicalDescription: 'a body' };
    const out = buildCharacterReferenceSheetPrompt(baseUniverse, sparse);
    // Defaults from REFERENCE_SHEET_CONSTANTS appear.
    for (const expr of ['neutral', 'curious', 'worried', 'surprised', 'amused', 'determined', 'relaxed']) {
      expect(out.prompt).toContain(expr);
    }
    for (const gesture of REFERENCE_SHEET_CONSTANTS.DEFAULT_HAND_GESTURES) {
      expect(out.prompt).toContain(gesture);
    }
  });

  it('omits zone sentences when the character has no data for that zone', () => {
    const minimal = { id: 'c-1', name: 'Min', physicalDescription: 'tall' };
    const out = buildCharacterReferenceSheetPrompt(baseUniverse, minimal);
    // No silhouette → no silhouette panel line.
    expect(out.prompt).not.toMatch(/Silhouette notes panel/);
    expect(out.prompt).not.toMatch(/Posture notes panel/);
    expect(out.prompt).not.toMatch(/Stats panel/);
    expect(out.prompt).not.toMatch(/Color palette zone/);
    expect(out.prompt).not.toMatch(/Prop showcase panel/);
    // But the always-rendered zones still appear.
    expect(out.prompt).toMatch(/Expression progression/);
    expect(out.prompt).toMatch(/Hand gestures panel/);
    expect(out.prompt).toMatch(/Wardrobe \/ accessories details panel/);
  });

  it('returns render options pinned to the universe-builder constants', () => {
    const out = buildCharacterReferenceSheetPrompt(baseUniverse, richCharacter);
    expect(out.width).toBe(REFERENCE_SHEET_CONSTANTS.DEFAULT_WIDTH);
    expect(out.height).toBe(REFERENCE_SHEET_CONSTANTS.DEFAULT_HEIGHT);
    // modelId resolution is deferred to render time (uses current settings,
    // not a hardcoded default). Pure prompt builder returns null so the
    // caller chooses — see resolveSheetModelId.
    expect(out.modelId).toBeNull();
    expect(out.negativePrompt).toContain('watermark');
    expect(out.negativePrompt).toContain('text artifacts');
  });

  it('returns pure-text payload — no init image or multi-reference fields', () => {
    // Regression guard for the text-template refactor: the renderer must not
    // re-introduce init-image / multi-ref plumbing without an explicit
    // backend-support audit. Codex (gpt-image-2) and external SD-API don't
    // share FLUX.2's CLI surface, and the user-validated path is text-only.
    const out = buildCharacterReferenceSheetPrompt(baseUniverse, richCharacter);
    expect(out).not.toHaveProperty('initImagePath');
    expect(out).not.toHaveProperty('initImageStrength');
    expect(out).not.toHaveProperty('referenceImagePaths');
    expect(out).not.toHaveProperty('referenceImageStrengths');
    // The "Honor the reference image" line was specific to the dropped init
    // image — keep it gone so the prompt doesn't hallucinate a missing input.
    expect(out.prompt).not.toMatch(/reference image/i);
  });

  it('throws a 400 when called with no universe or no character', () => {
    expect(() => buildCharacterReferenceSheetPrompt(null, richCharacter)).toThrow(/required/);
    expect(() => buildCharacterReferenceSheetPrompt(baseUniverse, null)).toThrow(/required/);
  });
});

describe('universeCharacterSheet — resolveSheetModelId', () => {
  const flux2Model = { id: 'flux2-klein-9b', runner: 'flux2' };
  const devModel = { id: 'dev', runner: 'mflux' };

  it('honors an explicit override when the model exists in the registry', () => {
    const out = resolveSheetModelId({
      override: 'dev',
      settings: { imageGen: { local: { modelId: 'flux2-klein-9b' } } },
      allModels: [flux2Model, devModel],
    });
    expect(out).toBe('dev');
  });

  it('ignores an override that does not match any registered model, falling through to settings', () => {
    const out = resolveSheetModelId({
      override: 'made-up-model',
      settings: { imageGen: { local: { modelId: 'dev' } } },
      allModels: [flux2Model, devModel],
    });
    expect(out).toBe('dev');
  });

  it('honors the user-configured local modelId from settings', () => {
    const out = resolveSheetModelId({
      override: '',
      settings: { imageGen: { local: { modelId: 'dev' } } },
      allModels: [flux2Model, devModel],
    });
    expect(out).toBe('dev');
  });

  it('falls back to the first available local model as a last resort', () => {
    const out = resolveSheetModelId({
      override: undefined,
      settings: {},
      allModels: [devModel, flux2Model],
    });
    expect(out).toBe('dev');
  });

  it('returns null when no models are registered (caller surfaces the 400)', () => {
    const out = resolveSheetModelId({ override: undefined, settings: {}, allModels: [] });
    expect(out).toBeNull();
  });
});

describe('universeCharacterSheet — variant catalog + prototype-pollution guard', () => {
  // Renderer/delete read the registry by string key. Without an own-property
  // check, an attacker can send `variant=constructor` (or any Object.prototype
  // member) through the route's `.string().min(1).max(48)` schema — bracket
  // access returns Object.prototype.constructor and the renderer crashes 500.
  // Verify the registry lookup rejects every Object.prototype name.
  it('listSheetVariants exposes the two registered variants', () => {
    const variants = listSheetVariants();
    const ids = variants.map((v) => v.id);
    expect(ids).toContain('standard');
    expect(ids).toContain('blueprint');
    for (const v of variants) {
      expect(v).toHaveProperty('label');
      expect(v).toHaveProperty('description');
    }
  });

  it('renderCharacterReferenceSheet rejects inherited Object.prototype member names with 400', async () => {
    // Lazy import so we can call without setting up the full universe stack;
    // the lookup error fires before any I/O.
    const { renderCharacterReferenceSheet } = await import('./universeCharacterSheet.js');
    for (const variant of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      await expect(
        renderCharacterReferenceSheet('u-1', 'c-1', { variant }),
      ).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    }
  });
});
