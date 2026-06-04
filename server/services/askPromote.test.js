import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the cross-domain services askPromote orchestrates so the test exercises
// only the latest-turn selection + target dispatch + pin-on-promote logic.
const convs = { getConversation: vi.fn(), setPromoted: vi.fn() };
const brainService = { captureThought: vi.fn() };
const cosService = { addTask: vi.fn() };
const identityService = { addProgressEntry: vi.fn() };

vi.mock('./askConversations.js', () => convs);
vi.mock('./brain.js', () => brainService);
vi.mock('./cos.js', () => cosService);
vi.mock('./identity.js', () => identityService);

const { latestAssistantTurn, promoteLatestAssistantTurn, promoteTurnById } = await import('./askPromote.js');

describe('askPromote.latestAssistantTurn', () => {
  it('returns the last assistant turn with non-empty content', () => {
    const conv = { turns: [
      { id: 't1', role: 'assistant', content: 'first answer' },
      { id: 't2', role: 'user', content: 'follow-up' },
      { id: 't3', role: 'assistant', content: 'second answer' },
    ] };
    expect(latestAssistantTurn(conv).id).toBe('t3');
  });

  it('skips a trailing empty/whitespace assistant turn', () => {
    const conv = { turns: [
      { id: 't1', role: 'assistant', content: 'real answer' },
      { id: 't2', role: 'assistant', content: '   ' },
    ] };
    expect(latestAssistantTurn(conv).id).toBe('t1');
  });

  it('returns null when there is no assistant turn', () => {
    expect(latestAssistantTurn({ turns: [{ id: 't1', role: 'user', content: 'q' }] })).toBeNull();
    expect(latestAssistantTurn({ turns: [] })).toBeNull();
    expect(latestAssistantTurn(null)).toBeNull();
  });
});

describe('askPromote.promoteLatestAssistantTurn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    convs.setPromoted.mockResolvedValue({ id: 'conv-1', promoted: true });
  });

  it('captures the latest answer to brain and pins the conversation', async () => {
    convs.getConversation.mockResolvedValue({ id: 'conv-1', turns: [
      { id: 't1', role: 'user', content: 'q' },
      { id: 't2', role: 'assistant', content: 'the answer' },
    ] });
    brainService.captureThought.mockResolvedValue({ inboxLog: { id: 'note-1' } });

    const result = await promoteLatestAssistantTurn({ conversationId: 'conv-1', target: 'brain' });
    expect(brainService.captureThought).toHaveBeenCalledWith('the answer');
    expect(convs.setPromoted).toHaveBeenCalledWith('conv-1', true);
    expect(result).toMatchObject({ target: 'brain', ref: { type: 'brain', id: 'note-1' } });
  });

  it('adds a task for the latest answer', async () => {
    convs.getConversation.mockResolvedValue({ id: 'conv-1', turns: [
      { id: 't2', role: 'assistant', content: 'do the thing' },
    ] });
    cosService.addTask.mockResolvedValue({ id: 'task-1' });

    const result = await promoteLatestAssistantTurn({ conversationId: 'conv-1', target: 'task' });
    expect(cosService.addTask).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'do the thing', priority: 'MEDIUM' }),
      'user'
    );
    expect(result).toMatchObject({ target: 'task', ref: { type: 'task', id: 'task-1' } });
  });

  it('logs the latest answer as a goal progress entry with the supplied goalId', async () => {
    convs.getConversation.mockResolvedValue({ id: 'conv-1', turns: [
      { id: 't2', role: 'assistant', content: 'progress note' },
    ] });
    identityService.addProgressEntry.mockResolvedValue({ id: 'entry-1' });

    const result = await promoteLatestAssistantTurn({ conversationId: 'conv-1', target: 'goal', goalId: 'g1' });
    expect(identityService.addProgressEntry).toHaveBeenCalledWith('g1', expect.objectContaining({ note: 'progress note' }));
    expect(convs.setPromoted).toHaveBeenCalledWith('conv-1', true);
    expect(result).toMatchObject({ target: 'goal', ref: { type: 'goal', id: 'g1', entryId: 'entry-1' } });
  });

  it('404s when the goal target references a missing goal', async () => {
    convs.getConversation.mockResolvedValue({ id: 'conv-1', turns: [{ id: 't2', role: 'assistant', content: 'note' }] });
    identityService.addProgressEntry.mockResolvedValue(null);
    await expect(promoteLatestAssistantTurn({ conversationId: 'conv-1', target: 'goal', goalId: 'gone' }))
      .rejects.toMatchObject({ status: 404 });
  });

  it('404s when the conversation has no assistant turn', async () => {
    convs.getConversation.mockResolvedValue({ id: 'conv-1', turns: [{ id: 't1', role: 'user', content: 'q' }] });
    await expect(promoteLatestAssistantTurn({ conversationId: 'conv-1', target: 'brain' }))
      .rejects.toMatchObject({ status: 404, code: 'NO_ASSISTANT_TURN' });
    expect(convs.setPromoted).not.toHaveBeenCalled();
  });

  it('404s when the conversation does not exist', async () => {
    convs.getConversation.mockResolvedValue(null);
    await expect(promoteLatestAssistantTurn({ conversationId: 'missing', target: 'brain' }))
      .rejects.toMatchObject({ status: 404 });
  });

  it('maps a duplicate task to a 409', async () => {
    convs.getConversation.mockResolvedValue({ id: 'conv-1', turns: [{ id: 't2', role: 'assistant', content: 'dupe' }] });
    cosService.addTask.mockResolvedValue({ duplicate: true });
    await expect(promoteLatestAssistantTurn({ conversationId: 'conv-1', target: 'task' }))
      .rejects.toMatchObject({ status: 409, code: 'DUPLICATE_TASK' });
  });
});

describe('askPromote.promoteTurnById', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    convs.setPromoted.mockResolvedValue({ id: 'conv-1', promoted: true });
  });

  it('promotes a specific assistant turn by id', async () => {
    convs.getConversation.mockResolvedValue({ id: 'conv-1', turns: [
      { id: 't1', role: 'assistant', content: 'older' },
      { id: 't2', role: 'assistant', content: 'target answer' },
    ] });
    brainService.captureThought.mockResolvedValue({ inboxLog: { id: 'note-2' } });

    const result = await promoteTurnById({ conversationId: 'conv-1', turnId: 't1', target: 'brain' });
    expect(brainService.captureThought).toHaveBeenCalledWith('older');
    expect(result.ref).toEqual({ type: 'brain', id: 'note-2' });
  });

  it('rejects a non-assistant turn with a 400', async () => {
    convs.getConversation.mockResolvedValue({ id: 'conv-1', turns: [{ id: 't1', role: 'user', content: 'q' }] });
    await expect(promoteTurnById({ conversationId: 'conv-1', turnId: 't1', target: 'brain' }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('404s on an unknown turn id', async () => {
    convs.getConversation.mockResolvedValue({ id: 'conv-1', turns: [{ id: 't1', role: 'assistant', content: 'a' }] });
    await expect(promoteTurnById({ conversationId: 'conv-1', turnId: 'nope', target: 'brain' }))
      .rejects.toMatchObject({ status: 404 });
  });
});
