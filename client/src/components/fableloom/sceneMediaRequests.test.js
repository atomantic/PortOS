import { describe, expect, it } from 'vitest';
import { buildFableLoomImageRequest, buildFableLoomVideoRequest } from './sceneMediaRequests';

const loom = { id: 'loom-1', styleNotes: 'cool rim light' };

describe('FableLoom scene media request composition', () => {
  // Uniquely catches the browser copying canon style into the scene's prompt again, or
  // adding the loom's style without listing it (#11317): the compiler adds universe style.
  it('sends the scene\'s text and lists the loom style it adds', () => {
    expect(buildFableLoomImageRequest({
      loom,
      episodeId: 'ep-1',
      node: { id: 'node-1', imagePrompt: 'a scout wakes in alien grass' },
    })).toEqual({
      prompt: 'a scout wakes in alien grass\n\nStyle: cool rim light',
      promptAdditions: [{ id: 'loom-style', label: 'Loom style', text: 'Style: cool rim light' }],
      width: 1024,
      height: 576,
      fableLoom: { loomId: 'loom-1', episodeId: 'ep-1', nodeId: 'node-1' },
    });
  });

  it('leaves typed continuity allocation to the server-side compiler', () => {
    const target = { id: 'node-3', imagePrompt: 'the scout enters a crystal observatory' };
    const episode = {
      nodes: [
        { id: 'node-unrelated', image: 'nearby.png', transitions: [] },
        {
          id: 'node-1',
          image: 'prior-shot.png',
          transitions: [{ id: 'tr-1', targetNodeId: target.id }],
        },
        target,
      ],
    };

    const request = buildFableLoomImageRequest({ loom, episode, episodeId: 'ep-1', node: target });
    expect(request).not.toHaveProperty('referenceImageFiles');
    expect(request.fableLoom).toEqual({ loomId: 'loom-1', episodeId: 'ep-1', nodeId: 'node-3' });
  });

  it('keeps an opening scene text-to-image when a loop points back to it', () => {
    const opening = { id: 'node-1', imagePrompt: 'the opening shot', transitions: [] };
    const episode = {
      startNodeId: opening.id,
      nodes: [
        opening,
        {
          id: 'node-ending',
          image: 'finale.png',
          transitions: [{ id: 'tr-loop', targetNodeId: opening.id }],
        },
      ],
    };

    expect(buildFableLoomImageRequest({ loom, episode, episodeId: 'ep-1', node: opening }))
      .not.toHaveProperty('initImageFile');
  });

  it('builds image-to-video direction from the shared camera vocabulary', () => {
    expect(buildFableLoomVideoRequest({
      loom,
      episodeId: 'ep-1',
      node: {
        id: 'node-1',
        prose: 'The gate opens.',
        videoPrompt: 'One continuous reveal.',
        cameraMovement: 'slow-dolly-in',
        image: 'scene.png',
      },
    })).toEqual({
      prompt: 'One continuous reveal.\n\nCamera direction: Camera slowly moves forward toward the subject.\n\nStyle: cool rim light',
      promptAdditions: [
        { id: 'camera-direction', label: 'Camera direction', text: 'Camera direction: Camera slowly moves forward toward the subject.' },
        { id: 'loom-style', label: 'Loom style', text: 'Style: cool rim light' },
      ],
      backend: 'local',
      mode: 'image',
      sourceImageFile: 'scene.png',
      disableAudio: true,
      width: 1024,
      height: 576,
      fableLoom: JSON.stringify({ loomId: 'loom-1', episodeId: 'ep-1', nodeId: 'node-1' }),
    });
  });

  it('uses one selected format for both storyboard stills and motion', () => {
    const portraitLoom = { ...loom, renderSettings: { formatId: 'portrait-9-16' } };
    const node = { id: 'node-1', imagePrompt: 'a portrait frame', videoPrompt: 'a portrait clip' };

    expect(buildFableLoomImageRequest({ loom: portraitLoom, episodeId: 'ep-1', node }))
      .toMatchObject({ width: 576, height: 1024 });
    expect(buildFableLoomVideoRequest({ loom: portraitLoom, episodeId: 'ep-1', node }))
      .toMatchObject({ width: 576, height: 1024 });
  });

  it('carries the saved image renderer and Codex effort into a scene request', () => {
    const preferredLoom = {
      ...loom,
      renderSettings: { formatId: 'landscape-16-9', imageMode: 'codex', effort: 'high' },
    };
    expect(buildFableLoomImageRequest({
      loom: preferredLoom,
      episodeId: 'ep-1',
      node: { id: 'node-1', imagePrompt: 'a lantern in the fog' },
    })).toMatchObject({ mode: 'codex', effort: 'high' });
  });

  it('carries the saved local video model or cloud backend into a scene request', () => {
    const localLoom = {
      ...loom,
      renderSettings: { formatId: 'landscape-16-9', videoMode: 'local', videoModel: 'video-model' },
    };
    expect(buildFableLoomVideoRequest({
      loom: localLoom,
      episodeId: 'ep-1',
      node: { id: 'node-1', videoPrompt: 'A lantern flickers.' },
    })).toMatchObject({ backend: 'local', modelId: 'video-model' });

    const grokLoom = { ...loom, renderSettings: { formatId: 'landscape-16-9', videoMode: 'grok' } };
    expect(buildFableLoomVideoRequest({
      loom: grokLoom,
      episodeId: 'ep-1',
      node: { id: 'node-1', videoPrompt: 'A lantern flickers.' },
    })).toMatchObject({ backend: 'grok' });
  });
});
