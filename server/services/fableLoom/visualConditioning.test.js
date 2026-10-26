import { describe, expect, it, vi } from 'vitest';
import { ServerError } from '../../lib/errorHandler.js';
import {
  compileFableLoomVisualRequest,
  fableLoomImageCapabilities,
  fableLoomVideoCapabilities,
} from './visualConditioning.js';

const identityPack = (prefix) => ({
  assets: [
    { role: 'neutral', imageRef: `${prefix}-neutral.png`, approved: true },
    { role: 'profile', imageRef: `${prefix}-profile.png`, approved: true },
    { role: 'full-body', imageRef: `${prefix}-body.png`, approved: true },
  ],
  avoid: [`wrong ${prefix} face`],
});

const universe = {
  id: 'universe-1',
  // Free-text direction authored for the WRITING stages: it names canon that
  // is nowhere near a given shot, so it must never reach a render prompt.
  styleNotes: 'Stage Aruun as a massive but local physical presence. Keep the tone PG-13.',
  influences: { embrace: ['ligne claire', 'flat matte color fields'], avoid: ['photoreal', 'gore'] },
  characters: [{
    id: 'char-a', name: 'Aria', physicalDescription: 'silver braid',
    imageRefs: ['aria-neutral.png', 'aria-profile.png', 'aria-body.png'],
    identityPack: identityPack('aria'),
    wardrobes: [{ id: 'wardrobe-red', name: 'Red coat', description: 'weathered wool' }],
  }, {
    id: 'char-b', name: 'Bex', physicalDescription: 'round glasses',
    imageRefs: ['bex-neutral.png', 'bex-profile.png', 'bex-body.png'],
    identityPack: identityPack('bex'),
  }],
  places: [{ id: 'place-1', name: 'Atrium', description: 'glass roof', primaryImageRef: 'atrium.png' }],
  objects: [{ id: 'object-1', name: 'Compass', description: 'brass', primaryImageRef: 'compass.png' }],
};

const loomWith = (visualCanon, { convergence = false } = {}) => ({
  id: 'loom-1', universeId: universe.id,
  episodes: [{
    id: 'episode-1', startNodeId: 'opening',
    nodes: [
      { id: 'opening', image: 'opening.png', transitions: [{ targetNodeId: 'shot' }] },
      ...(convergence ? [{ id: 'alternate', image: 'alternate.png', transitions: [{ targetNodeId: 'shot' }] }] : []),
      {
        id: 'shot', title: 'Aria enters the Atrium with the Compass', imagePrompt: 'A cautious arrival',
        visualCanon, transitions: [], image: 'storyboard.png',
      },
    ],
  }],
});

const deps = (loom) => ({
  loadLoom: vi.fn(async () => loom),
  loadUniverse: vi.fn(async () => universe),
  resolveAsset: (filename) => filename ? `/approved/${filename}` : null,
  resolveLoras: vi.fn(async () => [{
    filename: 'aria-v2.safetensors', scale: 0.75, triggerWord: 'ARIA_V2',
    character: { entryId: 'char-a' },
  }]),
  hashFile: vi.fn(async () => 'a'.repeat(64)),
  now: () => '2026-08-29T00:00:00.000Z',
});

const lockedBinding = {
  mode: 'locked',
  characterAppearances: [{
    characterId: 'char-a', wardrobeId: 'wardrobe-red', expression: 'alert', continuityNotes: 'coat stays wet',
  }],
  placeId: 'place-1', objectIds: ['object-1'], storyboardImageApproved: true,
};

describe('FableLoom visual conditioning compiler', () => {
  // Catches rejecting two cloud-bound characters or over-admitting their reference budget.
  it('admits locked Runway scenes with both approved identity anchors inside three slots', async () => {
    const loom = loomWith({ mode: 'locked', characterAppearances: [{ characterId: 'char-a' }, { characterId: 'char-b' }] });
    const capability = fableLoomImageCapabilities({ mode: 'runway', model: { id: 'gen4_image' }, inputBudget: 8 });
    expect(capability).toMatchObject({ referenceBudget: 3, multiCharacterPreservation: true });
    const result = await compileFableLoomVisualRequest({
      tag: { loomId: loom.id, episodeId: 'episode-1', nodeId: 'shot' }, kind: 'image', capability,
      authoredPrompt: 'Two rivals', ...deps(loom),
    });
    expect(result.visualConditioning.status).toBe('locked');
    expect(result.visualConditioning.assets.filter((asset) => asset.role === 'character-neutral').map((asset) => asset.label)).toEqual(['Aria', 'Bex']);
    expect(result.referenceImagePaths).toEqual(['/approved/opening.png', '/approved/aria-neutral.png', '/approved/bex-neutral.png']);
  });

  // Catches Runway's per-model reference cap being ignored, which would starve Seedream of anchors.
  it('admits Seedream with its own wider reference budget', () => {
    expect(fableLoomImageCapabilities({ mode: 'runway', model: { id: 'seedream5_pro' }, inputBudget: 12 })).toMatchObject({ referenceBudget: 10, multiCharacterPreservation: true });
  });

  it('compiles stable bindings, approved identity assets, adapters, graph continuity and provenance', async () => {
    const loom = loomWith(lockedBinding);
    const result = await compileFableLoomVisualRequest({
      tag: { loomId: loom.id, episodeId: 'episode-1', nodeId: 'shot' },
      kind: 'image',
      capability: fableLoomImageCapabilities({
        mode: 'local', model: { id: 'flux2-klein', runner: 'flux2', loraCompatKey: 'flux2-4b' }, inputBudget: 6,
      }),
      authoredPrompt: 'A cautious arrival',
      ...deps(loom),
    });

    expect(result.prompt).toContain('Character: Aria');
    expect(result.prompt).toContain('Wardrobe: Red coat');
    expect(result.prompt).toContain('ARIA_V2');
    expect(result.negativePrompt).toContain('wrong aria face');
    // Pin the complete render text before moving composition out of admission.
    expect(result.prompt).toBe([
      'Universe style: ligne claire, flat matte color fields',
      'Environment: Atrium. glass roof',
      'Character: Aria. silver braid. Wardrobe: Red coat weathered wool. Expression: alert. Continuity: coat stays wet. Identity adapter triggers: ARIA_V2',
      'Object: Compass. brass',
      'Presentation: no subtitles, captions, dialogue lettering, speech balloons, or text overlays. Dialogue is spoken audio only; never draw the script into the image.',
      'The preceding image is temporal context. Preserve recurring identities and props, but follow the current authored location and camera framing; do not copy the previous location across an intentional scene change.',
      'A cautious arrival',
    ].join('\n\n'));
    expect(result.negativePrompt).toBe('subtitles, captions, dialogue lettering, speech balloons, text overlays, photoreal, gore, wrong aria face');
    // Every block around the scene's text is listed for the render's chips (#11317).
    expect(result.promptAdditions.map((item) => item.label)).toEqual([
      'Universe style', 'Environment', 'Character: Aria', 'Object: Compass', 'No on-screen text',
      'Previous image continuity', 'Added to the negative prompt',
    ]);
    expect(result.promptAdditions.at(-1).text).toBe(result.negativePrompt);
    expect(result.visualConditioning.compiledPrompt).toBe(result.prompt);
    expect(result.visualConditioning.compiledNegativePrompt).toBe(result.negativePrompt);
    expect(result.visualConditioning).toMatchObject({
      status: 'locked', compilerVersion: '1.2.0', universeId: universe.id,
      temporalSourceNodeId: 'opening',
      bindings: { inferred: false, placeId: 'place-1', objectIds: ['object-1'] },
      adapters: [{ filename: 'aria-v2.safetensors', scale: 0.75, sha256: 'a'.repeat(64) }],
    });
    expect(result.visualConditioning.assets[0]).toMatchObject({ role: 'temporal-predecessor', filename: 'opening.png' });
    expect(result.referenceImagePaths.every((path) => path.startsWith('/approved/'))).toBe(true);
    expect(JSON.stringify(result.visualConditioning)).not.toContain('/approved/');
  });

  // Uniquely catches the compiler cutting a long scene prompt instead of sending it whole (#11317).
  it('sends a long scene prompt whole', async () => {
    const loom = loomWith(lockedBinding);
    const authoredPrompt = 'a long careful shot description. '.repeat(400);
    const result = await compileFableLoomVisualRequest({
      tag: { loomId: loom.id, episodeId: 'episode-1', nodeId: 'shot' }, kind: 'image',
      capability: fableLoomImageCapabilities({ mode: 'codex', inputBudget: 6 }), authoredPrompt, ...deps(loom),
    });
    expect(result.prompt.length).toBeGreaterThan(8000);
    expect(result.prompt.endsWith(authoredPrompt.trim())).toBe(true);
  });

  it('keeps a shared set across camera cuts without carrying that room into another scene', async () => {
    const loom = loomWith(lockedBinding);
    const [previous, current] = loom.episodes[0].nodes;
    previous.shot = { dramaticSceneId: 'scene-a', framing: 'Wide establishing view' };
    current.shot = { dramaticSceneId: 'scene-a', framing: 'Close profile from the same side of the axis' };
    const compile = () => compileFableLoomVisualRequest({
      tag: { loomId: loom.id, episodeId: 'episode-1', nodeId: 'shot' }, kind: 'image',
      capability: fableLoomImageCapabilities({ mode: 'codex', inputBudget: 6 }), ...deps(loom),
    });
    const result = await compile();
    expect(result.prompt).toContain('Same dramatic scene:');
    expect(result.prompt).toContain('room geometry');
    expect(result.prompt).toContain(current.shot.framing);
    expect(result.prompt).toContain('Dialogue is spoken audio only');
    expect(result.negativePrompt).toContain('subtitles');
    current.shot.dramaticSceneId = 'scene-b';
    const changed = await compile();
    expect(changed.prompt).not.toContain('Same dramatic scene:');
    expect(changed.prompt).toContain('intentional scene change');
  });

  it('preserves complete Reactor dialogue and rejects oversize shots before rendering', async () => {
    const loom = loomWith(lockedBinding);
    const current = loom.episodes[0].nodes[1];
    current.prose = 'ARIA\nThe last shuttle leaves tonight.';
    current.videoPrompt = 'She folds the ticket.';
    const compile = () => compileFableLoomVisualRequest({
      tag: { loomId: loom.id, episodeId: 'episode-1', nodeId: 'shot' }, kind: 'video',
      sourceImagePath: '/approved/storyboard.png',
      capability: fableLoomVideoCapabilities({ backend: 'reactor', model: { supportedModes: ['image'] } }), ...deps(loom),
    });
    const result = await compile();
    expect(result.prompt).toContain(current.prose);
    expect(result.prompt).toContain('No subtitles');
    expect(result.prompt.length).toBeLessThanOrEqual(800);
    expect(result.prompt).toBe([
      'Animate this reference as one continuous shot. Preserve its cast, room, props, lighting and screen direction. No subtitles, captions, speech balloons or text overlays. Dialogue is audio only.',
      'She folds the ticket.',
      'Script: ARIA\nThe last shuttle leaves tonight.',
    ].join('\n'));
    expect(result.negativePrompt).toBe('subtitles, captions, dialogue lettering, speech balloons, text overlays, photoreal, gore, wrong aria face');
    expect(result.visualConditioning.compiledPrompt).toBe(result.prompt);
    expect(result.visualConditioning.compiledNegativePrompt).toBe(result.negativePrompt);
    current.visualCanon = { ...lockedBinding, mode: 'draft', storyboardImageApproved: false };
    await expect(compile()).rejects.toMatchObject({ code: 'FABLELOOM_REACTOR_REFERENCE_REQUIRED' });
    current.visualCanon = lockedBinding;
    current.prose = 'x'.repeat(801);
    await expect(compile()).rejects.toMatchObject({ code: 'FABLELOOM_REACTOR_PROMPT_TOO_LONG' });
  });

  it('reports the Reactor reference error before accumulated locked-canon failures', async () => {
    const loom = loomWith({
      ...lockedBinding,
      storyboardImageApproved: false,
      characterAppearances: [{ characterId: 'missing-character' }],
    });
    await expect(compileFableLoomVisualRequest({
      tag: { loomId: loom.id, episodeId: 'episode-1', nodeId: 'shot' }, kind: 'video',
      sourceImagePath: '/approved/storyboard.png',
      capability: fableLoomVideoCapabilities({ backend: 'reactor', model: { supportedModes: ['image'] } }),
      ...deps(loom),
    })).rejects.toMatchObject({
      status: 422, code: 'FABLELOOM_REACTOR_REFERENCE_REQUIRED',
      message: 'Review and approve the current storyboard reference before rendering with Reactor.',
    });
  });

  it('uses the explicit draft character anchor without changing approved canon', async () => {
    const loom = loomWith({ ...lockedBinding, mode: 'draft', characterAppearances: [{ characterId: 'char-a', referenceImage: 'draft-anchor.png' }] });
    const result = await compileFableLoomVisualRequest({
      tag: { loomId: loom.id, episodeId: 'episode-1', nodeId: 'shot' }, kind: 'image',
      capability: fableLoomImageCapabilities({ mode: 'codex', inputBudget: 4 }),
      authoredPrompt: 'A cautious arrival', ...deps(loom),
    });
    expect(result.referenceImagePaths).toContain('/approved/draft-anchor.png');
    expect(result.visualConditioning.status).not.toBe('locked');
    const locked = loomWith({ ...lockedBinding, characterAppearances: [{ characterId: 'char-a', referenceImage: 'draft-anchor.png' }] });
    const approved = await compileFableLoomVisualRequest({
      tag: { loomId: locked.id, episodeId: 'episode-1', nodeId: 'shot' }, kind: 'image',
      capability: fableLoomImageCapabilities({ mode: 'codex', inputBudget: 6 }),
      authoredPrompt: 'A cautious arrival', ...deps(locked),
    });
    expect(approved.referenceImagePaths).not.toContain('/approved/draft-anchor.png');
    expect(approved.referenceImagePaths).toContain('/approved/aria-neutral.png');
  });

  it('renders curated style tokens once and never the writing-stage styleNotes', async () => {
    const loom = loomWith(lockedBinding);
    const result = await compileFableLoomVisualRequest({
      tag: { loomId: loom.id, episodeId: 'episode-1', nodeId: 'shot' },
      kind: 'image',
      capability: fableLoomImageCapabilities({ mode: 'codex', model: { id: 'gpt-image' }, inputBudget: 4 }),
      // What the browser actually POSTs: it composes the same universe preset
      // onto the scene prompt before the compiler ever sees it.
      authoredPrompt: 'ligne claire, flat matte color fields. A cautious arrival',
      authoredNegativePrompt: 'photoreal, gore',
      ...deps(loom),
    });

    expect(result.prompt).not.toContain('Aruun');
    expect(result.prompt).not.toContain('PG-13');
    // The tokens appear exactly once, and in FRONT of the canon context — a
    // diffusion model weights early tokens heaviest, so a surviving copy
    // stranded after the place/character blocks is not equivalent.
    expect(result.prompt.match(/ligne claire/g)).toHaveLength(1);
    expect(result.prompt.startsWith('Universe style: ligne claire, flat matte color fields')).toBe(true);
    expect(result.prompt.indexOf('Universe style:')).toBeLessThan(result.prompt.indexOf('Environment:'));
    expect(result.prompt).toContain('A cautious arrival');
    expect(result.negativePrompt.match(/photoreal/g)).toHaveLength(1);
    expect(result.negativePrompt.match(/gore/g)).toHaveLength(1);
  });

  it('strips a series style override the browser prepended so the tokens survive exactly once (#8442)', async () => {
    // Mirrors what `universeStylePreset(universe, series)` composes in the
    // browser (client/src/lib/universeStylePreset.js, now a re-export of the
    // server's) for a 'prepend'-mode (the default) series override: the
    // override leads, the universe embrace tokens trail.
    const loom = loomWith(lockedBinding);
    loom.seriesId = 'series-1';
    const series = { id: 'series-1', universeId: universe.id, stylePromptOverride: 'washed sepia tone', stylePromptOverrideMode: 'prepend' };
    const result = await compileFableLoomVisualRequest({
      tag: { loomId: loom.id, episodeId: 'episode-1', nodeId: 'shot' },
      kind: 'image',
      capability: fableLoomImageCapabilities({ mode: 'codex', model: { id: 'gpt-image' }, inputBudget: 4 }),
      authoredPrompt: 'washed sepia tone. ligne claire, flat matte color fields. A cautious arrival',
      loadSeries: vi.fn(async () => series),
      ...deps(loom),
    });

    expect(result.prompt.startsWith('Universe style: washed sepia tone. ligne claire, flat matte color fields')).toBe(true);
    expect(result.prompt.match(/ligne claire/g)).toHaveLength(1);
    expect(result.prompt.match(/flat matte color fields/g)).toHaveLength(1);
    expect(result.prompt.match(/washed sepia tone/g)).toHaveLength(1);
    expect(result.prompt).toContain('A cautious arrival');
  });

  it('drops the universe embrace tokens entirely for a series in override mode (#8442)', async () => {
    const loom = loomWith(lockedBinding);
    loom.seriesId = 'series-1';
    const series = { id: 'series-1', universeId: universe.id, stylePromptOverride: 'washed sepia tone', stylePromptOverrideMode: 'override' };
    const result = await compileFableLoomVisualRequest({
      tag: { loomId: loom.id, episodeId: 'episode-1', nodeId: 'shot' },
      kind: 'image',
      capability: fableLoomImageCapabilities({ mode: 'codex', model: { id: 'gpt-image' }, inputBudget: 4 }),
      authoredPrompt: 'washed sepia tone. A cautious arrival',
      loadSeries: vi.fn(async () => series),
      ...deps(loom),
    });

    expect(result.prompt.startsWith('Universe style: washed sepia tone')).toBe(true);
    expect(result.prompt).not.toContain('ligne claire');
    expect(result.prompt).not.toContain('flat matte color fields');
    expect(result.prompt).toContain('A cautious arrival');
    // Avoid tokens still come from the universe regardless of override mode.
    expect(result.negativePrompt).toContain('photoreal');
  });

  it('still contributes the curated style tokens a render prompt has not already named', async () => {
    const loom = loomWith(lockedBinding);
    const result = await compileFableLoomVisualRequest({
      tag: { loomId: loom.id, episodeId: 'episode-1', nodeId: 'shot' },
      kind: 'image',
      capability: fableLoomImageCapabilities({ mode: 'codex', model: { id: 'gpt-image' }, inputBudget: 4 }),
      authoredPrompt: 'A cautious arrival',
      ...deps(loom),
    });

    expect(result.prompt).toContain('Universe style: ligne claire, flat matte color fields');
    expect(result.negativePrompt).toContain('photoreal');
  });

  it('injects the loom canonical protagonist and locked wardrobe into an on-screen canon shot', async () => {
    const loom = loomWith({ ...lockedBinding, characterAppearances: [] });
    loom.protagonistCharacterId = 'char-a';
    loom.protagonistWardrobeId = 'wardrobe-red';
    loom.protagonistWardrobeLocked = true;

    const result = await compileFableLoomVisualRequest({
      tag: { loomId: loom.id, episodeId: 'episode-1', nodeId: 'shot' },
      kind: 'image',
      capability: fableLoomImageCapabilities({
        mode: 'local', model: { id: 'flux2-klein', runner: 'flux2' }, inputBudget: 6,
      }),
      ...deps(loom),
    });

    expect(result.prompt).toContain('Character: Aria');
    expect(result.prompt).toContain('Wardrobe: Red coat');
    expect(result.visualConditioning.bindings).toMatchObject({
      protagonist: { characterId: 'char-a', wardrobeId: 'wardrobe-red', presence: 'onscreen' },
      characterAppearances: [{ characterId: 'char-a', wardrobeId: 'wardrobe-red' }],
    });
  });

  it('omits the protagonist from an off-screen communicator scene while preserving the side-device manifest', async () => {
    const loom = loomWith({ ...lockedBinding });
    loom.protagonistCharacterId = 'char-a';
    loom.protagonistWardrobeId = 'wardrobe-red';
    loom.protagonistWardrobeLocked = true;
    loom.participationMode = 'helper';
    loom.episodes[0].nodes.at(-1).interactionWindow = {
      enabled: true,
      protagonistCharacterId: 'char-a',
      protagonistPresence: 'offscreen',
    };

    const result = await compileFableLoomVisualRequest({
      tag: { loomId: loom.id, episodeId: 'episode-1', nodeId: 'shot' },
      kind: 'image',
      capability: fableLoomImageCapabilities({
        mode: 'local', model: { id: 'flux2-klein', runner: 'flux2' }, inputBudget: 6,
      }),
      ...deps(loom),
    });

    expect(result.prompt).not.toContain('Character: Aria');
    expect(result.prompt).toContain('Aria, the canonical protagonist, is speaking through the communicator off-screen');
    expect(result.prompt).toContain('show the obstacle or environment the protagonist cannot see');
    expect(result.prompt).toContain('never use a standalone comms device as the subject');
    expect(result.negativePrompt).toContain('visible Aria');
    expect(result.negativePrompt).toContain('standalone communicator');
    expect(result.visualConditioning.bindings).toMatchObject({
      protagonist: { characterId: 'char-a', wardrobeId: 'wardrobe-red', presence: 'offscreen' },
      characterAppearances: [],
    });
    expect(result.visualConditioning.omitted).toContainEqual({
      role: 'character', bindingId: 'char-a', reason: 'protagonist-offscreen',
    });
  });

  it('keeps another character visible while the canonical protagonist is off-screen', async () => {
    const loom = loomWith({ mode: 'draft', characterAppearances: [{ characterId: 'char-b', referenceImage: 'bex-neutral.png' }] });
    loom.protagonistCharacterId = 'char-a';
    loom.episodes[0].nodes.at(-1).protagonistPresence = 'offscreen';
    const result = await compileFableLoomVisualRequest({
      tag: { loomId: loom.id, episodeId: 'episode-1', nodeId: 'shot' }, kind: 'image',
      capability: fableLoomImageCapabilities({ mode: 'codex', inputBudget: 4 }),
      authoredPrompt: 'Close-up of Bex telling a story.', ...deps(loom),
    });
    expect(result.prompt).toContain('keep Aria off-screen');
    expect(result.prompt).toContain('Show the explicitly bound cast (Bex)');
    expect(result.prompt).not.toContain('show the obstacle or environment');
    expect(result.negativePrompt).toContain('visible Aria');
    expect(result.negativePrompt).not.toContain('visible Bex');
    expect(result.referenceImagePaths).toContain('/approved/bex-neutral.png');
  });

  it('fails a locked render when a backend cannot preserve the bound cast', async () => {
    const loom = loomWith({
      ...lockedBinding,
      characterAppearances: [{ characterId: 'char-a' }, { characterId: 'char-b' }],
    });
    const run = compileFableLoomVisualRequest({
      tag: { loomId: loom.id, episodeId: 'episode-1', nodeId: 'shot' },
      kind: 'image',
      capability: fableLoomImageCapabilities({ mode: 'codex', inputBudget: 4 }),
      ...deps(loom),
    });
    await expect(run).rejects.toMatchObject({ code: 'FABLELOOM_CANON_CONDITIONING_UNAVAILABLE' });
  });

  it('requires an approved storyboard first frame for locked video and records capability degradation', async () => {
    const loom = loomWith({ ...lockedBinding, storyboardImageApproved: false });
    const capability = fableLoomVideoCapabilities({
      backend: 'local', model: { id: 'ltx-example', supportedModes: ['text', 'image', 'fflf'] },
    });
    await expect(compileFableLoomVisualRequest({
      tag: { loomId: loom.id, episodeId: 'episode-1', nodeId: 'shot' },
      kind: 'video', capability, sourceImagePath: '/approved/storyboard.png', ...deps(loom),
    })).rejects.toBeInstanceOf(ServerError);

    loom.episodes[0].nodes.at(-1).visualCanon.mode = 'draft';
    const draft = await compileFableLoomVisualRequest({
      tag: { loomId: loom.id, episodeId: 'episode-1', nodeId: 'shot' },
      kind: 'video', capability, sourceImagePath: '/approved/storyboard.png', ...deps(loom),
    });
    expect(draft.visualConditioning.status).toBe('degraded');
    expect(draft.referenceImagePaths).toEqual([]);
  });

  it('uses an explicit incoming source at convergence and rejects a non-incoming override', async () => {
    const loom = loomWith({ ...lockedBinding, continuitySourceNodeId: 'alternate' }, { convergence: true });
    const capability = fableLoomImageCapabilities({
      mode: 'local', model: { id: 'flux2-klein', runner: 'flux2' }, inputBudget: 8,
    });
    const valid = await compileFableLoomVisualRequest({
      tag: { loomId: loom.id, episodeId: 'episode-1', nodeId: 'shot' }, kind: 'image', capability, ...deps(loom),
    });
    expect(valid.visualConditioning.temporalSourceNodeId).toBe('alternate');

    loom.episodes[0].nodes.at(-1).visualCanon.continuitySourceNodeId = 'missing';
    await expect(compileFableLoomVisualRequest({
      tag: { loomId: loom.id, episodeId: 'episode-1', nodeId: 'shot' }, kind: 'image', capability, ...deps(loom),
    })).rejects.toMatchObject({ code: 'FABLELOOM_CANON_CONDITIONING_UNAVAILABLE' });

    delete loom.episodes[0].nodes.at(-1).visualCanon.continuitySourceNodeId;
    await expect(compileFableLoomVisualRequest({
      tag: { loomId: loom.id, episodeId: 'episode-1', nodeId: 'shot' }, kind: 'image', capability, ...deps(loom),
    })).rejects.toMatchObject({ code: 'FABLELOOM_CANON_CONDITIONING_UNAVAILABLE' });
  });

  it('records every compatible adapter that exceeds the backend budget and blocks locked output', async () => {
    const loom = loomWith(lockedBinding);
    const injected = deps(loom);
    injected.resolveLoras.mockResolvedValue([
      { filename: 'aria-a.safetensors', scale: 0.7, character: { entryId: 'char-a' } },
      { filename: 'aria-b.safetensors', scale: 0.8, character: { entryId: 'char-a' } },
    ]);
    const capability = {
      ...fableLoomImageCapabilities({
        mode: 'local', model: { id: 'flux2-klein', runner: 'flux2' }, inputBudget: 8,
      }),
      loraBudget: 1,
    };

    const run = compileFableLoomVisualRequest({
      tag: { loomId: loom.id, episodeId: 'episode-1', nodeId: 'shot' }, kind: 'image', capability, ...injected,
    });
    await expect(run).rejects.toMatchObject({
      code: 'FABLELOOM_CANON_CONDITIONING_UNAVAILABLE',
      context: { details: { visualConditioning: { omitted: [expect.objectContaining({
        role: 'character-adapter', filename: 'aria-b.safetensors', reason: 'adapter-budget',
      })] } } },
    });
  });

  it('keeps legacy inferred bindings explicitly draft/degraded', async () => {
    const loom = loomWith(null);
    const result = await compileFableLoomVisualRequest({
      tag: { loomId: loom.id, episodeId: 'episode-1', nodeId: 'shot' }, kind: 'image',
      capability: fableLoomImageCapabilities({ mode: 'external' }), ...deps(loom),
    });
    expect(result.visualConditioning).toMatchObject({ status: 'degraded', bindings: { inferred: true } });
    expect(result.visualConditioning.omitted.length).toBeGreaterThan(0);
  });

  it('resolves an older loom through its linked series and leaves unlinked legacy scenes unchanged', async () => {
    const loom = loomWith(lockedBinding);
    loom.universeId = null;
    loom.seriesId = 'series-1';
    const injected = deps(loom);
    const result = await compileFableLoomVisualRequest({
      tag: { loomId: loom.id, episodeId: 'episode-1', nodeId: 'shot' }, kind: 'image',
      capability: fableLoomImageCapabilities({
        mode: 'local', model: { id: 'flux2-klein', runner: 'flux2' }, inputBudget: 8,
      }),
      loadSeries: vi.fn(async () => ({ id: 'series-1', universeId: universe.id })),
      ...injected,
    });
    expect(result.visualConditioning.universeId).toBe(universe.id);

    loom.seriesId = null;
    loom.episodes[0].nodes.at(-1).visualCanon = null;
    await expect(compileFableLoomVisualRequest({
      tag: { loomId: loom.id, episodeId: 'episode-1', nodeId: 'shot' }, kind: 'image',
      capability: fableLoomImageCapabilities({ mode: 'external' }),
      ...injected,
    })).resolves.toBeNull();
  });
});

it('resolves a manual photography override once, preserves its finishing snapshot and honors Off', async () => {
  const { naturalUniverseVisualProfile } = await import('../../lib/universeVisualProfile.js');
  const { applyImageVisualProfile } = await import('../imageGen/visualProfile.js');
  const profile = naturalUniverseVisualProfile();
  const loom = loomWith(lockedBinding);
  const args = { tag: { loomId: loom.id, episodeId: 'episode-1', nodeId: 'shot' }, kind: 'image', capability: fableLoomImageCapabilities({ mode: 'codex', inputBudget: 8 }), authoredPrompt: 'A cautious arrival', ...deps(loom), loadUniverse: async () => ({ ...universe, visualProfile: profile }) };
  const compiled = await compileFableLoomVisualRequest({ ...args, visualProfileOverride: profile });
  const params = applyImageVisualProfile(compiled, compiled.visualProfile);
  for (const key of ['lighting', 'optics', 'materials']) expect(params.prompt.split(profile.generation[key])).toHaveLength(2);
  expect(params.visualProfile).toEqual(profile);
  const off = await compileFableLoomVisualRequest({ ...args, visualProfileOverride: null });
  expect(off.prompt).not.toContain(profile.generation.lighting);
  expect(off.visualProfile).toBeNull();
});
