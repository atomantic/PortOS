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
    expect(result.visualConditioning).toMatchObject({
      status: 'locked', compilerVersion: '1.1.0', universeId: universe.id,
      temporalSourceNodeId: 'opening',
      bindings: { inferred: false, placeId: 'place-1', objectIds: ['object-1'] },
      adapters: [{ filename: 'aria-v2.safetensors', scale: 0.75, sha256: 'a'.repeat(64) }],
    });
    expect(result.visualConditioning.assets[0]).toMatchObject({ role: 'temporal-predecessor', filename: 'opening.png' });
    expect(result.referenceImagePaths.every((path) => path.startsWith('/approved/'))).toBe(true);
    expect(JSON.stringify(result.visualConditioning)).not.toContain('/approved/');
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
    expect(result.visualConditioning.compiledPrompt).toBe(result.prompt);
    current.visualCanon = { ...lockedBinding, mode: 'draft', storyboardImageApproved: false };
    await expect(compile()).rejects.toMatchObject({ code: 'FABLELOOM_REACTOR_REFERENCE_REQUIRED' });
    current.visualCanon = lockedBinding;
    current.prose = 'x'.repeat(801);
    await expect(compile()).rejects.toMatchObject({ code: 'FABLELOOM_REACTOR_PROMPT_TOO_LONG' });
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
