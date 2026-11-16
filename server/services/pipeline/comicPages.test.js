/**
 * comicPages.test.js
 *
 * Comic page prompt composition, render+persist, refine and visual-image enqueue. Split from visualStages.test.js (#16214); shared mocks and state live in
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
  enqueueJobMock,
  getIssueMock,
  mockIssue,
  resolveCharacterLorasMock,
  runStagedLLMMock,
  updateStageMock,
  updateStageWithLatestMock,
} = h;
const {
  composeComicPagePrompt,
  renderComicPage,
  refineComicPanelPrompt,
  refineComicPageRender,
  generateComicPanelImagePrompts,
  enqueueVisualImage,
  resolveReferencePageIndex,
  resolveAutoReferenceIndex,
  resolveComicPageReference,
} = await import('./visualStages.js');

// The universeBuilder mock's getUniverse is auto-captured here so individual
// tests can feed enqueueVisualImage a canon (pickCanon reads universe.characters).
const { getUniverse } = await import('../universeBuilder.js');

beforeEach(() => {
  h.resetMocks();
});

const SERIES = {
  name: 'Bone Walker',
  styleNotes: 'gritty ink-wash, muted earthtones, heavy contrast',
};

const PAGE = {
  panels: [
    {
      description: 'Wide establishing shot inside a fossilized rib, morning sun streaming in.',
      caption: 'The titan died nine thousand years ago.',
      dialogue: [],
      sfx: '',
    },
    {
      description: 'Tight close-up — a beetle picks its way along polished bone.',
      caption: 'No one has told the rib.',
      dialogue: [{ character: 'KESSA', line: "If you had any sense, you'd stow away." }],
      sfx: 'fmp',
    },
  ],
};

describe('composeComicPagePrompt', () => {
  it('returns empty string when page has no panels', () => {
    expect(composeComicPagePrompt({ series: SERIES, page: { panels: [] }, pageNumber: 1 })).toBe('');
    expect(composeComicPagePrompt({ series: SERIES, page: null, pageNumber: 1 })).toBe('');
  });

  it('builds a multi-panel page layout prompt with series name, style, panel count, and per-panel breakdown', () => {
    const prompt = composeComicPagePrompt({ series: SERIES, page: PAGE, pageNumber: 1 });
    expect(prompt).toMatch(/single full printable comic book page/i);
    expect(prompt).toMatch(/"Bone Walker"/);
    expect(prompt).toMatch(/page 1/i);
    expect(prompt).toMatch(/2 clearly bordered panels/);
    expect(prompt).toMatch(/Art style: gritty ink-wash/);
    expect(prompt).toMatch(/Panel 1: Wide establishing shot/);
    expect(prompt).toMatch(/Panel 2: Tight close-up/);
    expect(prompt).toMatch(/Narration caption box reads: "The titan died/);
    expect(prompt).toMatch(/Speech balloon reads: "If you had any sense, you'd stow away\." \(spoken by KESSA\)\./);
    expect(prompt).toMatch(/SFX lettering: fmp/);
  });

  it('lifts parenthetical speaker modifiers into balloon-style hints without leaking them into the lettered text', () => {
    const page = {
      panels: [{
        description: 'Lina ducks behind a market stall, hand to her ear.',
        dialogue: [
          { character: 'ETTA (EARPIECE)', line: 'Stall forty-one is the buy.' },
          { character: 'LINA (WHISPERED)', line: "Don't get clever." },
          { character: 'LINA (THOUGHT)', line: 'He always gets clever.' },
        ],
      }],
    };
    const prompt = composeComicPagePrompt({ series: SERIES, page, pageNumber: 1 });
    // The lettered text is exactly the quoted line — no speaker label, no parenthetical.
    expect(prompt).toMatch(/Speech balloon reads: "Stall forty-one is the buy\." \(spoken by ETTA; jagged electronic\/transmission balloon[^)]*\)\./);
    expect(prompt).toMatch(/Speech balloon reads: "Don't get clever\." \(spoken by LINA; dashed-outline whisper balloon\)\./);
    expect(prompt).toMatch(/Speech balloon reads: "He always gets clever\." \(spoken by LINA; cloud-outline thought balloon[^)]*\)\./);
    // Defensive: the raw "(EARPIECE)" / "(WHISPERED)" / "(THOUGHT)" labels must
    // never appear inside the lettered balloon text. Scope the check to the
    // `Speech balloon reads: "..."` segments only — the layout instruction
    // itself legitimately cites these labels in quotes as a forbid-list.
    const balloonTexts = [...prompt.matchAll(/Speech balloon reads: "([^"]+)"/g)].map((m) => m[1]);
    expect(balloonTexts).toHaveLength(3);
    for (const text of balloonTexts) {
      expect(text).not.toMatch(/\(EARPIECE\)/);
      expect(text).not.toMatch(/\(WHISPERED\)/);
      expect(text).not.toMatch(/\(THOUGHT\)/);
      expect(text).not.toMatch(/^[A-Z]+:/); // no `NAME:` prefix inside balloon
    }
  });

  it('forbids speaker labels inside balloon lettering via the layout instruction', () => {
    const prompt = composeComicPagePrompt({ series: SERIES, page: PAGE, pageNumber: 1 });
    expect(prompt).toMatch(/balloon contains ONLY the quoted text/i);
    expect(prompt).toMatch(/NEVER letter the speaker's name/i);
  });

  it('renders a (SPEAKERS) PA line as a disembodied broadcast balloon not tailed to a visible character', () => {
    // The JUNO bug: a station-AI PA line marked `(SPEAKERS)` was getting a plain
    // balloon and the model tailed it to whoever was drawn (a newlywed).
    const page = {
      panels: [{
        description: 'Two newlyweds duck under exploding pearl light-orbs above a honeymoon bed.',
        dialogue: [{ character: 'JUNO (SPEAKERS)', line: 'Celebratory projectile beverages are permitted.' }],
      }],
    };
    const prompt = composeComicPagePrompt({ series: SERIES, page, pageNumber: 1 });
    expect(prompt).toMatch(/Speech balloon reads: "Celebratory projectile beverages are permitted\."/);
    expect(prompt).toMatch(/spoken by JUNO, who is NOT visible in this panel/);
    expect(prompt).toMatch(/do NOT attach the balloon tail to any visible character/);
    expect(prompt).toMatch(/broadcast\/PA balloon/);
    // The lettered text must not carry the `(SPEAKERS)` label.
    const balloonTexts = [...prompt.matchAll(/Speech balloon reads: "([^"]+)"/g)].map((m) => m[1]);
    expect(balloonTexts).toHaveLength(1);
    expect(balloonTexts[0]).not.toMatch(/SPEAKERS/);
  });

  it('treats a transmission-device modifier (EARPIECE) as electronic but NOT as off-panel', () => {
    // EARPIECE is ambiguous (a visible character may be speaking into it), so it
    // gets the electronic style WITHOUT the "not visible" disembodied claim.
    const page = { panels: [{ description: 'x', dialogue: [{ character: 'LINA (EARPIECE)', line: 'Copy that.' }] }] };
    const prompt = composeComicPagePrompt({ series: SERIES, page, pageNumber: 1 });
    expect(prompt).toMatch(/\(spoken by LINA; jagged electronic\/transmission balloon[^)]*\)/);
    expect(prompt).not.toMatch(/LINA, who is NOT visible/);
  });

  describe('resolveReferencePageIndex', () => {
    it("maps 'prior'/'next' relative to the current page", () => {
      expect(resolveReferencePageIndex('prior', 1, 3)).toBe(0);
      expect(resolveReferencePageIndex('next', 0, 3)).toBe(1);
    });
    it('accepts an explicit 0-based index', () => {
      expect(resolveReferencePageIndex(2, 0, 3)).toBe(2);
    });
    it('returns null when unset', () => {
      expect(resolveReferencePageIndex(undefined, 0, 3)).toBeNull();
      expect(resolveReferencePageIndex(null, 0, 3)).toBeNull();
    });
    it('throws out of range (prior on first page, next on last)', () => {
      expect(() => resolveReferencePageIndex('prior', 0, 3)).toThrow(/out of range/);
      expect(() => resolveReferencePageIndex('next', 2, 3)).toThrow(/out of range/);
      expect(() => resolveReferencePageIndex(5, 0, 3)).toThrow(/out of range/);
    });
    it('refuses a page referencing itself', () => {
      expect(() => resolveReferencePageIndex(1, 1, 3)).toThrow(/its own consistency reference/);
    });
  });

  describe('resolveAutoReferenceIndex', () => {
    const rendered = (scene) => ({ sceneNumber: scene, finalImage: { filename: 'x.png' } });
    const unrendered = (scene) => ({ sceneNumber: scene });

    it('chains off the prior page when it shares the scene AND is rendered', () => {
      const pages = [rendered(1), unrendered(1)];
      expect(resolveAutoReferenceIndex(pages, 1)).toBe(0);
    });
    it('breaks across a scene boundary (different scene number)', () => {
      const pages = [rendered(1), unrendered(2)];
      expect(resolveAutoReferenceIndex(pages, 1)).toBeNull();
    });
    it('skips when the prior page has no render yet (soft, no throw)', () => {
      const pages = [unrendered(1), unrendered(1)];
      expect(resolveAutoReferenceIndex(pages, 1)).toBeNull();
    });
    it('skips when scene markers are absent on either page (legacy scripts)', () => {
      const pages = [{ finalImage: { filename: 'x.png' } }, {}];
      expect(resolveAutoReferenceIndex(pages, 1)).toBeNull();
    });
    it('returns null on the first page (no prior)', () => {
      expect(resolveAutoReferenceIndex([rendered(1)], 0)).toBeNull();
    });
    it('falls back to the proof image when no final render exists', () => {
      const pages = [{ sceneNumber: 1, proofImage: { filename: 'p.png' } }, unrendered(1)];
      expect(resolveAutoReferenceIndex(pages, 1)).toBe(0);
    });
  });

  describe('resolveComicPageReference (precedence tiers)', () => {
    const rendered = (scene) => ({ sceneNumber: scene, finalImage: { filename: 'x.png' } });
    const unrendered = (scene) => ({ sceneNumber: scene });
    const pages = [rendered(1), { ...unrendered(1), proofImage: { filename: 'p.png' } }];

    it('explicit reference wins over proof-as-base and auto', () => {
      const r = resolveComicPageReference({ referencePage: 'prior', useProofAsBase: true, variant: 'final', pages, pageIndex: 1 });
      expect(r).toMatchObject({ referencePageIndex: 0, fromReference: true, autoReference: false, fromProof: false });
    });
    it('proof-as-base wins over auto on a final render', () => {
      const r = resolveComicPageReference({ referencePage: undefined, useProofAsBase: true, variant: 'final', pages, pageIndex: 1 });
      expect(r).toMatchObject({ fromProof: true, fromReference: false, autoReference: false });
    });
    it('auto chains within scene when no explicit ref and not proof-as-base', () => {
      const r = resolveComicPageReference({ referencePage: undefined, useProofAsBase: false, variant: 'proof', pages, pageIndex: 1 });
      expect(r).toMatchObject({ referencePageIndex: 0, fromReference: true, autoReference: true, fromProof: false });
    });
    it("'none' opts out of auto chaining but leaves proof-as-base (orthogonal)", () => {
      const withProof = resolveComicPageReference({ referencePage: 'none', useProofAsBase: true, variant: 'final', pages, pageIndex: 1 });
      expect(withProof).toMatchObject({ referencePageIndex: null, fromReference: false, autoReference: false, fromProof: true });
      // A proof render with 'none' and no proof-as-base box → fully fresh, no reference.
      const fresh = resolveComicPageReference({ referencePage: 'none', useProofAsBase: false, variant: 'proof', pages, pageIndex: 1 });
      expect(fresh).toMatchObject({ referencePageIndex: null, fromReference: false, autoReference: false, fromProof: false });
    });
    it('across a scene boundary, auto yields nothing', () => {
      const crossScene = [rendered(1), unrendered(2)];
      const r = resolveComicPageReference({ referencePage: undefined, useProofAsBase: false, variant: 'proof', pages: crossScene, pageIndex: 1 });
      expect(r.fromReference).toBe(false);
    });
  });

  it('uses singular "panel" wording for a one-panel splash page', () => {
    const splash = { panels: [{ description: 'Hero stands silhouetted against the sunrise.' }] };
    const prompt = composeComicPagePrompt({ series: SERIES, page: splash, pageNumber: 5 });
    expect(prompt).toMatch(/1 clearly bordered panel\b/);
    expect(prompt).not.toMatch(/clearly bordered panels\b/);
  });

  it('skips empty caption / dialogue / sfx fields without leaving dangling labels', () => {
    const sparse = {
      panels: [
        { description: 'A solitary frame.', caption: '', dialogue: [], sfx: '' },
      ],
    };
    const prompt = composeComicPagePrompt({ series: SERIES, page: sparse, pageNumber: 1 });
    expect(prompt).toMatch(/Panel 1: A solitary frame\./);
    expect(prompt).not.toMatch(/Caption:/);
    expect(prompt).not.toMatch(/Dialogue:/);
    expect(prompt).not.toMatch(/SFX:/);
  });

  it('falls back to "continuation of previous beat" when a panel has no description', () => {
    const noDesc = { panels: [{ description: '' }] };
    const prompt = composeComicPagePrompt({ series: SERIES, page: noDesc, pageNumber: 1 });
    expect(prompt).toMatch(/Panel 1: continuation of previous beat\./);
  });

  it('prepends the world style tokens (influences.embrace) when a world is provided', () => {
    // The universe's style prompt now lives as a chip-token list on
    // `influences.embrace`. visualStages joins them verbatim into the
    // rendered prompt the same way the legacy prose `stylePrompt` did.
    const world = {
      influences: {
        embrace: ['cinematic ink illustration', 'dramatic lighting'],
        avoid: [],
      },
    };
    const prompt = composeComicPagePrompt({ series: SERIES, world, page: PAGE, pageNumber: 1 });
    expect(prompt).toMatch(/cinematic ink illustration/);
  });

  it('mode=prepend (default): override leads, universe embrace tokens trail', () => {
    // A per-series override lets one series in a shared universe deviate
    // visually (e.g. a noir spin-off) without forking the universe. The
    // default 'prepend' mode places override first so its tokens land in
    // the heaviest position, with the universe style trailing.
    const world = {
      influences: {
        embrace: ['cinematic ink illustration', 'dramatic lighting'],
        avoid: [],
      },
    };
    const seriesWithOverride = { ...SERIES, stylePromptOverride: 'moody noir lighting, high contrast monochrome' };
    const prompt = composeComicPagePrompt({ series: seriesWithOverride, world, page: PAGE, pageNumber: 1 });
    const overrideAt = prompt.indexOf('moody noir lighting');
    const universeAt = prompt.indexOf('cinematic ink illustration');
    expect(overrideAt).toBeGreaterThanOrEqual(0);
    expect(universeAt).toBeGreaterThanOrEqual(0);
    expect(overrideAt).toBeLessThan(universeAt);
  });

  it('mode=append: universe leads, override trails', () => {
    const world = {
      influences: { embrace: ['cinematic ink illustration', 'dramatic lighting'], avoid: [] },
    };
    const series = { ...SERIES, stylePromptOverride: 'moody noir lighting', stylePromptOverrideMode: 'append' };
    const prompt = composeComicPagePrompt({ series, world, page: PAGE, pageNumber: 1 });
    const overrideAt = prompt.indexOf('moody noir lighting');
    const universeAt = prompt.indexOf('cinematic ink illustration');
    expect(overrideAt).toBeGreaterThan(universeAt);
  });

  it('mode=override: drops the universe embrace tokens entirely', () => {
    const world = {
      influences: { embrace: ['cinematic ink illustration', 'dramatic lighting'], avoid: [] },
    };
    const series = { ...SERIES, stylePromptOverride: 'moody noir lighting', stylePromptOverrideMode: 'override' };
    const prompt = composeComicPagePrompt({ series, world, page: PAGE, pageNumber: 1 });
    expect(prompt).toMatch(/moody noir lighting/);
    expect(prompt).not.toMatch(/cinematic ink illustration/);
  });

  it('falls through to universe-only style when stylePromptOverride is empty (any mode)', () => {
    const world = {
      influences: { embrace: ['cinematic ink illustration'], avoid: [] },
    };
    // Mode is ignored when there's no override text — universe always wins.
    for (const mode of ['prepend', 'append', 'override']) {
      const series = { ...SERIES, stylePromptOverride: '', stylePromptOverrideMode: mode };
      const prompt = composeComicPagePrompt({ series, world, page: PAGE, pageNumber: 1 });
      expect(prompt).toMatch(/cinematic ink illustration/);
    }
  });

  it('applies stylePromptOverride even without a universe (no embrace tokens)', () => {
    // The override is independent of the universe — if the universe has no
    // embrace tokens, the override still threads through.
    const seriesWithOverride = { ...SERIES, stylePromptOverride: 'experimental rotoscope' };
    const prompt = composeComicPagePrompt({ series: seriesWithOverride, page: PAGE, pageNumber: 1 });
    expect(prompt).toMatch(/experimental rotoscope/);
  });

  it('appends extraStyle into the Art style clause', () => {
    const prompt = composeComicPagePrompt({
      series: SERIES,
      page: PAGE,
      pageNumber: 1,
      extraStyle: 'aged paper texture',
    });
    expect(prompt).toMatch(/Art style: gritty ink-wash, muted earthtones, heavy contrast, aged paper texture/);
  });

  it('does not double-punctuate when description / caption / sfx already end in . ! ?', () => {
    const page = {
      panels: [{
        description: 'Wide shot with morning sun streaming in.',
        caption: 'No one has told the rib.',
        dialogue: [{ character: 'KESSA', line: 'Move it!' }],
        sfx: 'CRASH!',
      }],
    };
    const prompt = composeComicPagePrompt({ series: SERIES, page, pageNumber: 1 });
    // Each pre-terminated segment should keep its terminator, never `..` or `!.`.
    expect(prompt).not.toMatch(/streaming in\.\./);
    expect(prompt).not.toMatch(/has told the rib\.\."/);
    expect(prompt).not.toMatch(/Move it!\."/);
    expect(prompt).not.toMatch(/CRASH!\./);
  });

  it('still appends a terminator when the field has no sentence-end punctuation', () => {
    const page = { panels: [{ description: 'A solitary frame', sfx: 'fmp' }] };
    const prompt = composeComicPagePrompt({ series: SERIES, page, pageNumber: 1 });
    expect(prompt).toMatch(/Panel 1: A solitary frame\./);
    expect(prompt).toMatch(/SFX lettering: fmp\./);
  });

  it('injects matched-place palette / era / weather / recurringDetails into the Setting clause', () => {
    const matchedPlaces = [
      {
        name: 'The Rib',
        description: 'cathedral-scale fossil interior',
        palette: 'bone-white, dust-gold',
        era: 'nine thousand years post-titan',
        weather: 'still air, soft dawn shafts',
        recurringDetails: 'beetles tracking across polished bone',
      },
    ];
    const prompt = composeComicPagePrompt({ series: SERIES, page: PAGE, pageNumber: 1, matchedPlaces });
    expect(prompt).toMatch(/Setting — The Rib: cathedral-scale fossil interior/);
    expect(prompt).toMatch(/Palette: bone-white, dust-gold/);
    expect(prompt).toMatch(/Era: nine thousand years post-titan/);
    expect(prompt).toMatch(/Weather: still air, soft dawn shafts/);
    expect(prompt).toMatch(/beetles tracking across polished bone/);
    // Order within the per-place clause mirrors RICH_SPEC: description first
    // (identity anchor), then palette/era/weather, then recurringDetails.
    const settingBlock = prompt.match(/Setting — [^\n]+/)?.[0] || '';
    expect(settingBlock.indexOf('cathedral-scale fossil interior'))
      .toBeLessThan(settingBlock.indexOf('Palette:'));
    expect(settingBlock.indexOf('Palette:'))
      .toBeLessThan(settingBlock.indexOf('Era:'));
    expect(settingBlock.indexOf('Era:'))
      .toBeLessThan(settingBlock.indexOf('Weather:'));
    expect(settingBlock.indexOf('Weather:'))
      .toBeLessThan(settingBlock.indexOf('beetles'));
  });

  it('skips per-place empty fragments without emitting bare prefixes', () => {
    const matchedPlaces = [
      { name: 'The Rib', description: 'fossil interior', palette: '', era: '', weather: '', recurringDetails: '' },
    ];
    const prompt = composeComicPagePrompt({ series: SERIES, page: PAGE, pageNumber: 1, matchedPlaces });
    expect(prompt).toMatch(/Setting — The Rib: fossil interior/);
    expect(prompt).not.toMatch(/Palette:/);
    expect(prompt).not.toMatch(/Era:/);
    expect(prompt).not.toMatch(/Weather:/);
  });

  it('joins multiple matched places with " | " in the Setting clause', () => {
    const matchedPlaces = [
      { name: 'The Rib', description: 'fossil interior', era: 'post-titan' },
      { name: 'Sun Pier', description: 'wooden dock', weather: 'salt fog' },
    ];
    const prompt = composeComicPagePrompt({ series: SERIES, page: PAGE, pageNumber: 1, matchedPlaces });
    expect(prompt).toMatch(/The Rib: fossil interior\. Era: post-titan \| Sun Pier: wooden dock\. Weather: salt fog/);
  });
});



describe('refineComicPanelPrompt', () => {
  it('rejects a non-integer pageIndex / panelIndex', async () => {
    await expect(refineComicPanelPrompt('iss-test', 'nope', 0)).rejects.toThrow(/non-negative integers/);
    await expect(refineComicPanelPrompt('iss-test', 0, -1)).rejects.toThrow(/non-negative integers/);
  });

  it('returns 404 when the page does not exist', async () => {
    await expect(refineComicPanelPrompt('iss-test', 99, 0)).rejects.toThrow(/page.*out of range|PIPELINE_COMIC_PAGE_NOT_FOUND/);
  });

  it('returns 404 when the panel does not exist', async () => {
    await expect(refineComicPanelPrompt('iss-test', 0, 99)).rejects.toThrow(/panel.*out of range|PIPELINE_COMIC_PANEL_NOT_FOUND/);
  });

  it('rejects when the panel has no description', async () => {
    getIssueMock.mockResolvedValueOnce({
      ...structuredClone(mockIssue),
      stages: { ...mockIssue.stages, comicPages: { pages: [{ panels: [{ description: '   ' }] }] } },
    });
    await expect(refineComicPanelPrompt('iss-test', 0, 0)).rejects.toThrow(/no description to refine/);
  });

  it('rejects when the LLM returns an empty refined prompt', async () => {
    runStagedLLMMock.mockResolvedValueOnce({
      content: { prompt: '   ', changes: [] }, runId: 'r', providerId: 'p', model: 'm',
    });
    await expect(refineComicPanelPrompt('iss-test', 0, 0)).rejects.toThrow(/empty refined prompt/);
  });

  it('happy path: replaces the panel description and returns changes + runId', async () => {
    const result = await refineComicPanelPrompt('iss-test', 0, 0);
    expect(result.runId).toBe('run-abc12345');
    expect(result.changes).toEqual(['tightened the framing']);
    expect(runStagedLLMMock).toHaveBeenCalledWith(
      'pipeline-comic-panel-image-prompt',
      expect.objectContaining({ description: expect.stringContaining('Panel 1 baseline.') }),
      expect.objectContaining({ returnsJson: true }),
    );
    expect(updateStageMock).toHaveBeenCalledWith('iss-test', 'comicPages', expect.objectContaining({
      status: 'edited',
      pages: expect.arrayContaining([
        expect.objectContaining({
          panels: expect.arrayContaining([
            expect.objectContaining({ description: 'refined prompt body' }),
          ]),
        }),
      ]),
    }));
  });
});

describe('refineComicPageRender', () => {
  // A comicPages stage with page 0 already rendered (proof slot carries a
  // filename + stored prompt — the two things a from-self refine needs).
  const issueWithRenderedPage = (slots) => ({
    ...structuredClone(mockIssue),
    stages: {
      ...mockIssue.stages,
      comicPages: {
        pages: [{
          panels: [{ description: 'Panel 1 baseline.', dialogue: [], caption: '', sfx: '' }],
          ...slots,
        }],
      },
    },
  });

  it('rejects a non-integer pageIndex', async () => {
    await expect(refineComicPageRender('iss-test', { pageIndex: 'nope', instruction: 'x' }))
      .rejects.toThrow(/non-negative integer/);
  });

  it('rejects an empty instruction', async () => {
    await expect(refineComicPageRender('iss-test', { pageIndex: 0, instruction: '   ' }))
      .rejects.toThrow(/instruction is required/);
  });

  it('returns 404 when the page does not exist', async () => {
    await expect(refineComicPageRender('iss-test', { pageIndex: 99, instruction: 'warm the light' }))
      .rejects.toThrow(/out of range|PIPELINE_COMIC_PAGE_NOT_FOUND/);
  });

  it('rejects when the page has no rendered image to refine', async () => {
    getIssueMock.mockResolvedValueOnce(issueWithRenderedPage({}));
    await expect(refineComicPageRender('iss-test', { pageIndex: 0, instruction: 'warm the light' }))
      .rejects.toThrow(/no rendered image yet|PIPELINE_COMIC_REFINE_NO_RENDER/);
  });

  it('rejects when the rendered slot has no stored prompt to adjust', async () => {
    getIssueMock.mockResolvedValueOnce(issueWithRenderedPage({
      proofImage: { jobId: 'j1', filename: 'page0-proof.png', prompt: '' },
    }));
    await expect(refineComicPageRender('iss-test', { pageIndex: 0, instruction: 'warm the light' }))
      .rejects.toThrow(/stored render prompt is missing|PIPELINE_COMIC_REFINE_NO_PROMPT/);
  });

  it('happy path: adjusts the proof prompt and enqueues an i2i render from the existing image', async () => {
    getIssueMock.mockResolvedValueOnce(issueWithRenderedPage({
      proofImage: { jobId: 'j1', filename: 'page0-proof.png', prompt: 'original page prompt' },
    }));

    const result = await refineComicPageRender('iss-test', { pageIndex: 0, instruction: 'warm the lighting' });

    // Variant defaults to proof (no final exists); LLM-adjusted prompt + meta.
    expect(result.variant).toBe('proof');
    expect(result.prompt).toBe('refined prompt body');
    expect(result.runId).toBe('run-abc12345');
    expect(result.changes).toEqual(['tightened the framing']);

    // The refine template — NOT the from-script page compose — is run, and it
    // is fed the current prompt + the user instruction.
    expect(runStagedLLMMock).toHaveBeenCalledWith(
      'pipeline-comic-page-refine-render',
      expect.objectContaining({ currentPrompt: 'original page prompt', instruction: 'warm the lighting', pageNumber: 1 }),
      expect.objectContaining({ returnsJson: true }),
    );

    // The render is image-to-image from the page's own image at the default
    // refine denoise.
    expect(enqueueJobMock).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'image',
      params: expect.objectContaining({
        prompt: 'refined prompt body',
        initImagePath: expect.stringContaining('page0-proof.png'),
        initImageStrength: 0.35,
      }),
    }));

    // #2241 — the refined render slot is persisted (enqueue+persist in one call)
    // so the filename hook can attach the completed image; the slot carries the
    // returned jobId + adjusted prompt on the proof variant.
    expect(updateStageWithLatestMock).toHaveBeenCalledWith('iss-test', 'comicPages', expect.any(Function));
    expect(result.stage.pages[0].proofImage).toMatchObject({
      jobId: 'job-fake-1234', filename: null, prompt: 'refined prompt body',
    });
  });

  it('honors target=final and an explicit initImageStrength', async () => {
    getIssueMock.mockResolvedValueOnce(issueWithRenderedPage({
      proofImage: { jobId: 'j1', filename: 'page0-proof.png', prompt: 'proof prompt' },
      finalImage: { jobId: 'j2', filename: 'page0-final.png', prompt: 'final prompt' },
    }));

    const result = await refineComicPageRender('iss-test', {
      pageIndex: 0, instruction: 'remove the extra signage text', target: 'final', initImageStrength: 0.2,
    });

    expect(result.variant).toBe('final');
    expect(runStagedLLMMock).toHaveBeenCalledWith(
      'pipeline-comic-page-refine-render',
      expect.objectContaining({ currentPrompt: 'final prompt' }),
      expect.anything(),
    );
    expect(enqueueJobMock).toHaveBeenCalledWith(expect.objectContaining({
      params: expect.objectContaining({
        initImagePath: expect.stringContaining('page0-final.png'),
        initImageStrength: 0.2,
      }),
    }));
  });

  it('refines a legacy-shaped page (root filename/prompt) by reading the legacy slot as the base', async () => {
    // Pre proof/final-split record: render lives at the page root, not in a
    // proofImage slot. The client surfaces this as the proof slot and shows
    // Refine, so the service must resolve it too (else NO_RENDER 400).
    getIssueMock.mockResolvedValueOnce(issueWithRenderedPage({
      imageJobId: 'legacy-job', filename: 'page0-legacy.png', prompt: 'legacy page prompt',
    }));

    const result = await refineComicPageRender('iss-test', { pageIndex: 0, instruction: 'tweak the sky' });

    expect(result.variant).toBe('proof');
    expect(runStagedLLMMock).toHaveBeenCalledWith(
      'pipeline-comic-page-refine-render',
      expect.objectContaining({ currentPrompt: 'legacy page prompt' }),
      expect.anything(),
    );
    expect(enqueueJobMock).toHaveBeenCalledWith(expect.objectContaining({
      params: expect.objectContaining({ initImagePath: expect.stringContaining('page0-legacy.png') }),
    }));
  });

  it('auto-prefers the final render as the refine base when both slots exist', async () => {
    getIssueMock.mockResolvedValueOnce(issueWithRenderedPage({
      proofImage: { jobId: 'j1', filename: 'page0-proof.png', prompt: 'proof prompt' },
      finalImage: { jobId: 'j2', filename: 'page0-final.png', prompt: 'final prompt' },
    }));

    const result = await refineComicPageRender('iss-test', { pageIndex: 0, instruction: 'tweak' });

    expect(result.variant).toBe('final');
    expect(enqueueJobMock).toHaveBeenCalledWith(expect.objectContaining({
      params: expect.objectContaining({ initImagePath: expect.stringContaining('page0-final.png') }),
    }));
  });
});

describe('generateComicPanelImagePrompts', () => {
  it('reuses the panel validation (404 on a missing panel)', async () => {
    await expect(generateComicPanelImagePrompts('iss-test', 0, 99, { count: 2 }))
      .rejects.toThrow(/panel.*out of range|PIPELINE_COMIC_PANEL_NOT_FOUND/);
  });

  it('runs the template `count` times and returns that many candidates without persisting', async () => {
    let n = 0;
    runStagedLLMMock.mockImplementation(async () => {
      n += 1;
      return { content: { prompt: `candidate ${n}`, changes: [`c${n}`] }, runId: `run-${n}`, providerId: 'codex', model: 'gpt-4o' };
    });
    const result = await generateComicPanelImagePrompts('iss-test', 0, 0, { count: 3 });
    expect(runStagedLLMMock).toHaveBeenCalledTimes(3);
    expect(result.requested).toBe(3);
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates.map((c) => c.prompt)).toEqual(['candidate 1', 'candidate 2', 'candidate 3']);
    expect(result).toMatchObject({ pageIndex: 0, panelIndex: 0 });
    // Non-destructive: must NOT write the stage back.
    expect(updateStageMock).not.toHaveBeenCalled();
  });

  it('tolerates partial failure — returns survivors when some calls reject', async () => {
    let n = 0;
    runStagedLLMMock.mockImplementation(async () => {
      n += 1;
      if (n === 2) throw new Error('provider hiccup');
      return { content: { prompt: `ok ${n}`, changes: [] }, runId: `run-${n}`, providerId: 'codex', model: 'm' };
    });
    const result = await generateComicPanelImagePrompts('iss-test', 0, 0, { count: 3 });
    expect(result.requested).toBe(3);
    expect(result.candidates).toHaveLength(2);
  });

  it('throws when every candidate call fails', async () => {
    runStagedLLMMock.mockRejectedValue(new Error('all down'));
    await expect(generateComicPanelImagePrompts('iss-test', 0, 0, { count: 2 })).rejects.toThrow(/all down/);
  });

  it('clamps an oversized count to the candidate cap', async () => {
    runStagedLLMMock.mockResolvedValue({
      content: { prompt: 'x', changes: [] }, runId: 'r', providerId: 'p', model: 'm',
    });
    const result = await generateComicPanelImagePrompts('iss-test', 0, 0, { count: 99 });
    expect(result.requested).toBe(6);
    expect(runStagedLLMMock).toHaveBeenCalledTimes(6);
  });

  it('defaults to a single candidate when count is omitted', async () => {
    const result = await generateComicPanelImagePrompts('iss-test', 0, 0);
    expect(result.requested).toBe(1);
    expect(runStagedLLMMock).toHaveBeenCalledTimes(1);
  });
});


describe('renderComicPage (enqueue + persist)', () => {
  it('enqueues then persists the proof slot onto stages.comicPages.pages[0].proofImage', async () => {
    const result = await renderComicPage('iss-test', { pageIndex: 0, width: 832, height: 1216 });
    expect(result.jobId).toBe('job-fake-1234');
    expect(enqueueJobMock).toHaveBeenCalledTimes(1);
    expect(updateStageWithLatestMock).toHaveBeenCalledWith('iss-test', 'comicPages', expect.any(Function));
    expect(result.stage.pages[0].proofImage).toMatchObject({
      jobId: 'job-fake-1234', filename: null, width: 832, height: 1216,
    });
    // proof slot must NOT carry the final-only fromProof flag
    expect(result.stage.pages[0].proofImage).not.toHaveProperty('fromProof');
    expect(result.stage.status).toBe('edited');
  });

  it('persists onto finalImage (with fromProof) when target=final + useProofAsBase', async () => {
    getIssueMock.mockResolvedValueOnce({
      ...structuredClone(mockIssue),
      stages: {
        ...mockIssue.stages,
        comicPages: {
          pages: [{
            panels: [{ description: 'Panel 1 baseline.', dialogue: [], caption: '', sfx: '' }],
            proofImage: { filename: 'page0-proof.png' },
          }],
        },
      },
    });
    const result = await renderComicPage('iss-test', { pageIndex: 0, target: 'final', useProofAsBase: true });
    expect(result.variant).toBe('final');
    expect(result.stage.pages[0].finalImage).toMatchObject({ jobId: 'job-fake-1234', fromProof: true });
  });

  it('surfaces a 404 for an out-of-range pageIndex', async () => {
    await expect(renderComicPage('iss-test', { pageIndex: 99 }))
      .rejects.toThrow(/out of range|PIPELINE_COMIC_PAGE_NOT_FOUND/);
  });
});


describe('enqueueVisualImage characterAppearances enforcement', () => {
  const canonWorld = {
    characters: [
      { id: 'char-aria', name: 'Aria', physicalDescription: 'tall', wardrobes: [{ id: 'wd-coat', name: 'Trench', description: 'long coat' }] },
    ],
  };

  it('rejects a dangling characterId with a 400 before enqueueing', async () => {
    getUniverse.mockResolvedValueOnce(canonWorld);
    await expect(enqueueVisualImage('iss-test', 'storyboards', {
      description: 'A scene with Aria',
      characterAppearances: [{ characterId: 'char-ghost' }],
    })).rejects.toMatchObject({ status: 400, code: 'PIPELINE_VISUAL_BAD_CHARACTER' });
    expect(enqueueJobMock).not.toHaveBeenCalled();
  });

  it('rejects a mismatched wardrobeId with a 400 before enqueueing', async () => {
    getUniverse.mockResolvedValueOnce(canonWorld);
    await expect(enqueueVisualImage('iss-test', 'storyboards', {
      description: 'A scene with Aria',
      characterAppearances: [{ characterId: 'char-aria', wardrobeId: 'wd-nope' }],
    })).rejects.toMatchObject({ status: 400, code: 'PIPELINE_VISUAL_BAD_WARDROBE' });
    expect(enqueueJobMock).not.toHaveBeenCalled();
  });

  it('enqueues when picks resolve (valid wardrobe + null wardrobe)', async () => {
    getUniverse.mockResolvedValueOnce(canonWorld);
    const result = await enqueueVisualImage('iss-test', 'storyboards', {
      description: 'A scene with Aria',
      characterAppearances: [{ characterId: 'char-aria', wardrobeId: 'wd-coat' }],
    });
    expect(result.jobId).toBe('job-fake-1234');
    expect(enqueueJobMock).toHaveBeenCalledTimes(1);
  });
});

// Guards the character-LoRA auto-apply WIRING: trained LoRAs resolved for
// matched characters must reach enqueueJob params (local mode), weave their
// trigger words into the prompt, and stay out entirely on opt-out.
describe('enqueueVisualImage character-LoRA auto-apply', () => {
  beforeEach(() => {
    resolveCharacterLorasMock.mockClear();
    resolveCharacterLorasMock.mockResolvedValue([]);
  });

  const canonWorld = {
    characters: [
      { id: 'char-aria', name: 'Aria', physicalDescription: 'tall, copper hair' },
    ],
  };
  const ariaLora = {
    filename: 'lora-trained-aria-12345678.safetensors',
    scale: 1.0,
    triggerWord: 'aria_tok',
    character: { entryId: 'char-aria', ingredientId: null, name: 'Aria' },
  };

  it('passes resolved LoRAs into job params and appends trigger words', async () => {
    getUniverse.mockResolvedValueOnce(canonWorld);
    resolveCharacterLorasMock.mockResolvedValueOnce([ariaLora]);
    const result = await enqueueVisualImage('iss-test', 'storyboards', {
      description: 'A scene with Aria',
    });
    const { params } = enqueueJobMock.mock.calls.at(-1)[0];
    expect(params.loraFilenames).toEqual([ariaLora.filename]);
    expect(params.loraScales).toEqual([1.0]);
    expect(result.prompt).toContain('Aria (aria_tok)');
  });

  it('skips resolution entirely when applyCharacterLoras is false', async () => {
    getUniverse.mockResolvedValueOnce(canonWorld);
    await enqueueVisualImage('iss-test', 'storyboards', {
      description: 'A scene with Aria',
      applyCharacterLoras: false,
    });
    expect(resolveCharacterLorasMock).not.toHaveBeenCalled();
    const { params } = enqueueJobMock.mock.calls.at(-1)[0];
    expect(params.loraFilenames).toBeUndefined();
  });

  it('omits lora params when no trained LoRA matches', async () => {
    getUniverse.mockResolvedValueOnce(canonWorld);
    resolveCharacterLorasMock.mockResolvedValueOnce([]);
    const result = await enqueueVisualImage('iss-test', 'storyboards', {
      description: 'A scene with Aria',
    });
    const { params } = enqueueJobMock.mock.calls.at(-1)[0];
    expect(params.loraFilenames).toBeUndefined();
    expect(result.prompt).not.toContain('aria_tok');
  });
});

describe('composeComicPagePrompt trigger-word weaving', () => {
  const page = { panels: [{ description: 'Aria stands on the cliff' }] };
  const matched = [{ id: 'char-aria', name: 'Aria', physicalDescription: 'tall, copper hair' }];

  it('parenthesizes the trigger word after the character name', () => {
    const prompt = composeComicPagePrompt({
      series: { name: 'Test' }, world: null, page, pageNumber: 1,
      matchedCharacters: matched,
      loraTriggerByKey: new Map([['char-aria', 'aria_tok']]),
    });
    expect(prompt).toContain('Aria (aria_tok): tall, copper hair');
  });

  it('renders plain names without a trigger map', () => {
    const prompt = composeComicPagePrompt({
      series: { name: 'Test' }, world: null, page, pageNumber: 1,
      matchedCharacters: matched,
    });
    expect(prompt).toContain('Aria: tall, copper hair');
    expect(prompt).not.toContain('aria_tok');
  });
});
