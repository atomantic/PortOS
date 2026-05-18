import { describe, it, expect, beforeAll } from 'vitest';
import { copyFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { buildCharacterReferenceSheetPrompt, REFERENCE_SHEET_CONSTANTS } from './universeCharacterSheet.js';
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
    expect(out.modelId).toBe(REFERENCE_SHEET_CONSTANTS.DEFAULT_MODEL);
    expect(out.negativePrompt).toContain('watermark');
    expect(out.negativePrompt).toContain('text artifacts');
  });

  it('resolves the shipped template asset path', () => {
    // Repo ships data.sample/templates/character-reference-sheet.png; the
    // setup-data flow copies it into data/templates/ which resolveTemplateAsset
    // queries. The local dev tree has both, so initImagePath should be
    // non-null. If a future move breaks the resolution, this test catches it.
    const out = buildCharacterReferenceSheetPrompt(baseUniverse, richCharacter);
    expect(out.initImagePath).toBeTruthy();
    expect(out.initImagePath).toContain('character-reference-sheet.png');
    expect(out.initImageStrength).toBe(REFERENCE_SHEET_CONSTANTS.TEMPLATE_INIT_STRENGTH);
  });

  it('falls back to no reference images when the character has no primaryImageRef', () => {
    const out = buildCharacterReferenceSheetPrompt(baseUniverse, richCharacter);
    expect(out.referenceImagePaths).toEqual([]);
    expect(out.referenceImageStrengths).toEqual([]);
  });

  it('throws a 400 when called with no universe or no character', () => {
    expect(() => buildCharacterReferenceSheetPrompt(null, richCharacter)).toThrow(/required/);
    expect(() => buildCharacterReferenceSheetPrompt(baseUniverse, null)).toThrow(/required/);
  });
});
