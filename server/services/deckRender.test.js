import { describe, it, expect, vi, beforeEach } from 'vitest';

const enqueueJob = vi.fn(async () => ({ jobId: 'job-1', position: 1, status: 'queued' }));
const getSettings = vi.fn();
const getDeck = vi.fn();
const markCardsRenderQueued = vi.fn(async () => ({}));
const resolveLocalImageModel = vi.fn(() => ({ pythonPath: '/py', selectedModel: { id: 'flux2-klein-4b' } }));
vi.mock('./mediaJobQueue/index.js', () => ({ enqueueJob }));
vi.mock('./settings.js', () => ({ getSettings }));
vi.mock('./decks.js', () => ({ getDeck, markCardsRenderQueued }));
vi.mock('./imageGen/index.js', () => ({ resolveImageCleaners: () => ({ cleanC2PA: false, denoise: false }) }));
vi.mock('./imageGen/prepareParams.js', () => ({
  resolveLocalImageModel,
}));
const resolveRenderTargetConfig = vi.fn();
vi.mock('./imageGen/cloudProviderConfig.js', () => ({ resolveRenderTargetConfig }));

const { renderDeckCards, selectCardsToRender } = await import('./deckRender.js');

const cards = [
  { id: 'a', key: 'spades-A', name: 'Ace of Spades', prompt: 'one spade', negativePrompt: '', imageRefs: [] },
  { id: 'b', key: 'spades-2', name: 'Two of Spades', prompt: 'two spades', negativePrompt: 'text', imageRefs: ['done.png'] },
  { id: 'c', key: 'spades-3', name: 'Three of Spades', prompt: '', negativePrompt: '', imageRefs: [] },
];
const deck = {
  id: 'd1', name: 'Deck', kind: 'playing', imageMode: null, imageModelId: null,
  influences: { embrace: ['engraving'], avoid: ['blurry'] }, layoutPrompt: 'Full card',
  cardSize: { width: 1024, height: 1536 }, cards,
};

describe('selectCardsToRender', () => {
  it('always skips prompt-less cards, honors an id list, and onlyMissing drops rendered cards', () => {
    expect(selectCardsToRender(cards).map((c) => c.id)).toEqual(['a', 'b']);
    expect(selectCardsToRender(cards, { onlyMissing: true }).map((c) => c.id)).toEqual(['a']);
    expect(selectCardsToRender(cards, { cardIds: ['b', 'c'] }).map((c) => c.id)).toEqual(['b']);
  });
});

describe('renderDeckCards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDeck.mockResolvedValue(deck);
    getSettings.mockResolvedValue({ imageGen: { mode: 'local', local: { pythonPath: '/py' } } });
  });

  it('rejects a non-queueable backend before touching the queue', async () => {
    resolveRenderTargetConfig.mockReturnValue({ mode: 'external', cloud: null });
    await expect(renderDeckCards('d1', {})).rejects.toMatchObject({ code: 'DECK_EXTERNAL_UNSUPPORTED', status: 400 });
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('queues one tagged local job per renderable card with the composed prompt and stamps the card', async () => {
    resolveRenderTargetConfig.mockReturnValue({ mode: 'local', cloud: null });
    const result = await renderDeckCards('d1', { onlyMissing: true, seed: 7 });
    expect(resolveRenderTargetConfig).toHaveBeenCalledWith(expect.anything(), 'deck', expect.objectContaining({ recordMode: null, fallbackMode: 'external' }));
    expect(result).toEqual({ mode: 'local', jobs: [{ cardId: 'a', key: 'spades-A', jobId: 'job-1' }], skipped: 2 });
    expect(enqueueJob).toHaveBeenCalledTimes(1);
    const { kind, params, owner } = enqueueJob.mock.calls[0][0];
    expect(kind).toBe('image');
    expect(owner).toBe('decks');
    expect(params).toMatchObject({
      mode: 'local', pythonPath: '/py', modelId: 'flux2-klein-4b', width: 1024, height: 1536, seed: 7,
      prompt: expect.stringContaining('Standard two-way playing-card face'),
      negativePrompt: expect.stringContaining('six rendered as nine'),
      deckCard: { deckId: 'd1', cardId: 'a', key: 'spades-A' },
    });
    expect(markCardsRenderQueued).toHaveBeenCalledTimes(1);
    expect(markCardsRenderQueued).toHaveBeenCalledWith('d1', [{ cardId: 'a', render: expect.objectContaining({ jobId: 'job-1', status: 'queued', mode: 'local', model: 'flux2-klein-4b' }) }]);
  });

  it('spreads the cloud job params under the card params and threads the resolved model', async () => {
    resolveRenderTargetConfig.mockReturnValue({ mode: 'codex', cloud: { enabled: true, modelId: 'gpt-image-2', jobParams: { mode: 'codex', model: 'gpt-image-2', effort: 'high' } } });
    await renderDeckCards('d1', { cardIds: ['b'] });
    const { params } = enqueueJob.mock.calls[0][0];
    expect(params).toMatchObject({
      mode: 'codex', model: 'gpt-image-2', effort: 'high',
      negativePrompt: expect.stringContaining('text, upright duplicate bottom-right index'),
      deckCard: { cardId: 'b' },
    });
    expect(params.pythonPath).toBeUndefined();
    expect(markCardsRenderQueued.mock.calls[0][1][0].render).toMatchObject({ model: 'gpt-image-2' });
  });

  it('400s when nothing is renderable instead of queueing an empty batch', async () => {
    resolveRenderTargetConfig.mockReturnValue({ mode: 'local', cloud: null });
    await expect(renderDeckCards('d1', { cardIds: ['c'] })).rejects.toMatchObject({ code: 'DECK_NO_RENDERABLE_CARDS' });
  });

  it('does not leak a cloud model pin into the local resolver when provider falls back to local (#7363)', async () => {
    getDeck.mockResolvedValue({
      ...deck,
      imageMode: 'codex',
      imageModelId: 'gemini-3-pro-image',
    });
    // Codex is disabled/benched: resolveRenderTargetConfig falls back to local
    resolveRenderTargetConfig.mockReturnValue({ mode: 'local', cloud: null });

    await renderDeckCards('d1', { cardIds: ['a'] });

    expect(resolveRenderTargetConfig).toHaveBeenCalledWith(
      expect.anything(),
      'deck',
      expect.objectContaining({ recordMode: 'codex', recordModel: 'gemini-3-pro-image' }),
    );
    expect(resolveLocalImageModel).toHaveBeenCalledWith(
      expect.anything(),
      { modelId: undefined },
    );
    const { params } = enqueueJob.mock.calls[0][0];
    expect(params).toMatchObject({
      mode: 'local',
      modelId: 'flux2-klein-4b',
    });
    expect(params.modelId).not.toBe('gemini-3-pro-image');
  });

  it('preserves a local model pin when the deck is pinned to local mode', async () => {
    getDeck.mockResolvedValue({
      ...deck,
      imageMode: 'local',
      imageModelId: 'flux2-schnell',
    });
    resolveRenderTargetConfig.mockReturnValue({ mode: 'local', cloud: null });

    await renderDeckCards('d1', { cardIds: ['a'] });

    expect(resolveLocalImageModel).toHaveBeenCalledWith(
      expect.anything(),
      { modelId: 'flux2-schnell' },
    );
  });
});
