import { describe, it, expect, beforeAll } from 'vitest';
import { copyFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { buildCharacterReferenceSheetPrompt, REFERENCE_SHEET_CONSTANTS, resolveSheetModelId } from './universeCharacterSheet.js';
import { PATHS } from '../lib/fileUtils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLE_TEMPLATE = join(__dirname, '..', '..', 'data.sample', 'templates', 'character-reference-sheet.png');

// Clean checkouts may not have `data/templates/` (created by setup/migration);
// provision the tracked sample asset so the resolver finds it without
// depending on a separate `npm run install:all` step before `npm test`.
beforeAll(() => {
  if (!existsSync(PATHS.visualTemplates)) mkdirSync(PATHS.visualTemplates, { recursive: true });
  const dest = join(PATHS.visualTemplates, 'character-reference-sheet.png');
  if (!existsSync(dest) && existsSync(SAMPLE_TEMPLATE)) {
    copyFileSync(SAMPLE_TEMPLATE, dest);
  }
});

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

  it('resolves the shipped template asset path under /data/templates/ (NOT /data/images/)', () => {
    // Regression guard for: previously the builder returned a template-dir
    // path, but generateImage's `resolveGalleryImage` re-validation only
    // accepted /data/images/ and silently dropped the template — meaning the
    // sheet was rendered with no init-image anchor at all. local.js now uses
    // resolveImageInputPath which accepts both roots.
    const out = buildCharacterReferenceSheetPrompt(baseUniverse, richCharacter);
    expect(out.initImagePath).toBeTruthy();
    expect(out.initImagePath).toContain('character-reference-sheet.png');
    expect(out.initImagePath).toMatch(/data\/templates\//);
    expect(out.initImagePath).not.toMatch(/data\/images\//);
    expect(out.initImageStrength).toBe(REFERENCE_SHEET_CONSTANTS.TEMPLATE_INIT_STRENGTH);
  });

  it('falls back to no reference images when the character has no primaryImageRef', () => {
    const out = buildCharacterReferenceSheetPrompt(baseUniverse, richCharacter);
    expect(out.referenceImagePaths).toEqual([]);
    expect(out.referenceImageStrengths).toEqual([]);
  });

  it('resolves character.primaryImageRef against the gallery (where canon portraits live), NOT image-refs', () => {
    // Regression guard for: primaryImageRef is a gallery filename (lives in
    // data/images/, alongside the rest of character.imageRefs[]). Previously
    // the builder ran it through resolveImageRef which only looks under
    // data/image-refs/ — so the portrait was always null and never made it
    // to FLUX.2 as a multi-ref input.
    const galleryDir = PATHS.images;
    if (!existsSync(galleryDir)) mkdirSync(galleryDir, { recursive: true });
    const fixtureName = 'portos-test-portrait.png';
    const fixturePath = join(galleryDir, fixtureName);
    if (!existsSync(fixturePath) && existsSync(SAMPLE_TEMPLATE)) {
      copyFileSync(SAMPLE_TEMPLATE, fixturePath);
    }
    const charWithPortrait = { ...richCharacter, imageRefs: [fixtureName], primaryImageRef: fixtureName };
    const out = buildCharacterReferenceSheetPrompt(baseUniverse, charWithPortrait);
    expect(out.referenceImagePaths).toHaveLength(1);
    expect(out.referenceImagePaths[0]).toMatch(/data\/images\//);
    expect(out.referenceImagePaths[0]).toContain(fixtureName);
    expect(out.referenceImageStrengths[0]).toBe(REFERENCE_SHEET_CONSTANTS.PORTRAIT_REFERENCE_STRENGTH);
  });

  it('throws a 400 when called with no universe or no character', () => {
    expect(() => buildCharacterReferenceSheetPrompt(null, richCharacter)).toThrow(/required/);
    expect(() => buildCharacterReferenceSheetPrompt(baseUniverse, null)).toThrow(/required/);
  });
});

describe('universeCharacterSheet — resolveSheetModelId', () => {
  const flux2Model = { id: 'flux2-klein-9b', runner: 'flux2' };
  const flux2Small = { id: 'flux2-klein-4b', runner: 'flux2' };
  const devModel = { id: 'dev', runner: 'mflux' };

  it('honors an explicit override when the model exists in the registry (even non-FLUX.2)', () => {
    // Explicit user choice wins even if it loses the portrait anchor.
    const out = resolveSheetModelId({
      override: 'dev',
      settings: { imageGen: { local: { modelId: 'flux2-klein-9b' } } },
      allModels: [flux2Model, flux2Small, devModel],
    });
    expect(out).toBe('dev');
  });

  it('ignores an override that does not match any registered model', () => {
    // Falls through to the FLUX.2-first precedence — settings says dev
    // (non-FLUX.2), so the first FLUX.2 model wins instead.
    const out = resolveSheetModelId({
      override: 'made-up-model',
      settings: { imageGen: { local: { modelId: 'dev' } } },
      allModels: [flux2Model, devModel],
    });
    expect(out).toBe('flux2-klein-9b');
  });

  it('honors the user-configured local modelId from settings when it IS FLUX.2', () => {
    const out = resolveSheetModelId({
      override: '',
      settings: { imageGen: { local: { modelId: 'flux2-klein-4b' } } },
      allModels: [flux2Model, flux2Small, devModel],
    });
    expect(out).toBe('flux2-klein-4b');
  });

  it('REGRESSION: prefers an available FLUX.2 model over a non-FLUX.2 settings model', () => {
    // Without this preference, picking the user's settings model (dev) would
    // silently drop the portrait multi-ref input. Better to upgrade to FLUX.2
    // automatically and only fall back to dev when no FLUX.2 is registered.
    const out = resolveSheetModelId({
      override: '',
      settings: { imageGen: { local: { modelId: 'dev' } } },
      allModels: [flux2Model, devModel],
    });
    expect(out).toBe('flux2-klein-9b');
  });

  it('falls back to the first FLUX.2 model when no override and no FLUX.2 settings', () => {
    const out = resolveSheetModelId({
      override: undefined,
      settings: {},
      allModels: [devModel, flux2Small, flux2Model],
    });
    expect(out).toBe('flux2-klein-4b');
  });

  it('falls back to the settings model (non-FLUX.2) when no FLUX.2 is registered', () => {
    const out = resolveSheetModelId({
      override: '',
      settings: { imageGen: { local: { modelId: 'dev' } } },
      allModels: [devModel],
    });
    expect(out).toBe('dev');
  });

  it('falls back to the first available local model as a last resort', () => {
    const out = resolveSheetModelId({
      override: undefined,
      settings: {},
      allModels: [devModel],
    });
    expect(out).toBe('dev');
  });

  it('returns null when no models are registered (caller surfaces the 400)', () => {
    const out = resolveSheetModelId({ override: undefined, settings: {}, allModels: [] });
    expect(out).toBeNull();
  });
});
