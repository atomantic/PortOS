import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../services/askConversations.js', () => ({
  listConversations: vi.fn(),
  getConversation: vi.fn(),
  createConversation: vi.fn(),
  appendTurn: vi.fn(),
  deleteConversation: vi.fn(),
  setPromoted: vi.fn(),
  // The route's idSchema is built from this regex — keep it in lockstep with
  // the real export (9-char base36 ms + 8-char hex suffix) so route-level
  // validation in tests matches production.
  ID_RE: /^ask_[a-z0-9]{9}_[a-f0-9]{8}$/,
}));

vi.mock('../services/askService.js', () => ({
  // The route imports the literal Set and spreads it for zod — keep the real
  // type so zod validation matches what production sees.
  VALID_MODES: new Set(['ask', 'advise', 'draft']),
  runAsk: vi.fn(),
}));

vi.mock('../services/brain.js', () => ({
  captureThought: vi.fn(),
}));

vi.mock('../services/cos.js', () => ({
  addTask: vi.fn(),
}));

vi.mock('../services/identity.js', () => ({
  addProgressEntry: vi.fn(),
}));

const convs = await import('../services/askConversations.js');
const svc = await import('../services/askService.js');
const brainService = await import('../services/brain.js');
const cosService = await import('../services/cos.js');
const identityService = await import('../services/identity.js');
const { default: routes } = await import('./ask.js');

const makeApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/ask', routes);
  app.use(errorMiddleware);
  return app;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/ask', () => {
  it('returns a list of conversation summaries', async () => {
    convs.listConversations.mockResolvedValue([
      { id: 'ask_lwg2x4abc_abcdef12', title: 'Old', mode: 'ask', turnCount: 2, createdAt: 'x', updatedAt: 'x', promoted: false },
    ]);
    const res = await request(makeApp()).get('/api/ask');
    expect(res.status).toBe(200);
    expect(res.body.conversations).toHaveLength(1);
  });
});

describe('GET /api/ask/:id', () => {
  it('404s for missing conversation', async () => {
    convs.getConversation.mockResolvedValue(null);
    const res = await request(makeApp()).get('/api/ask/ask_lwg2x4abc_deadbeef');
    expect(res.status).toBe(404);
  });

  it('returns the conversation', async () => {
    convs.getConversation.mockResolvedValue({ id: 'ask_lwg2x4abc_a1b2c3d4', turns: [], mode: 'ask' });
    const res = await request(makeApp()).get('/api/ask/ask_lwg2x4abc_a1b2c3d4');
    expect(res.status).toBe(200);
    expect(res.body.conversation.id).toBe('ask_lwg2x4abc_a1b2c3d4');
  });
});

describe('DELETE /api/ask/:id', () => {
  it('deletes when the service confirms', async () => {
    convs.deleteConversation.mockResolvedValue(true);
    const res = await request(makeApp()).delete('/api/ask/ask_lwg2x4abc_a1b2c3d4');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('404s when nothing was removed', async () => {
    convs.deleteConversation.mockResolvedValue(false);
    const res = await request(makeApp()).delete('/api/ask/ask_lwg2x4abc_a1b2c3d4');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/ask/:id/promote', () => {
  it('promotes the conversation', async () => {
    convs.setPromoted.mockResolvedValue({ id: 'ask_lwg2x4abc_a1b2c3d4', promoted: true });
    const res = await request(makeApp())
      .post('/api/ask/ask_lwg2x4abc_a1b2c3d4/promote')
      .send({ promoted: true });
    expect(res.status).toBe(200);
    expect(convs.setPromoted).toHaveBeenCalledWith('ask_lwg2x4abc_a1b2c3d4', true);
  });

  it('404s when the conversation does not exist', async () => {
    convs.setPromoted.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/ask/ask_lwg2x4abc_a1b2c3d4/promote')
      .send({ promoted: true });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/ask/:id/turns/:turnId/promote', () => {
  const convId = 'ask_lwg2x4abc_a1b2c3d4';
  const fullConv = {
    id: convId,
    mode: 'ask',
    promoted: false,
    turns: [
      { id: 'u1', role: 'user', content: 'what should I do?' },
      { id: 'a1', role: 'assistant', content: 'Block 30 minutes for deep work after lunch.' },
    ],
  };

  it('promotes an assistant turn to a Brain note and pins the conversation', async () => {
    convs.getConversation.mockResolvedValue(fullConv);
    convs.setPromoted.mockResolvedValue({ ...fullConv, promoted: true });
    brainService.captureThought.mockResolvedValue({ inboxLog: { id: 'inbox-1' } });

    const res = await request(makeApp())
      .post(`/api/ask/${convId}/turns/a1/promote`)
      .send({ target: 'brain' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.target).toBe('brain');
    expect(res.body.ref).toEqual({ type: 'brain', id: 'inbox-1' });
    expect(res.body.conversation.promoted).toBe(true);
    expect(brainService.captureThought).toHaveBeenCalledWith('Block 30 minutes for deep work after lunch.');
    expect(convs.setPromoted).toHaveBeenCalledWith(convId, true);
  });

  it('promotes an assistant turn to a CoS task with priority and source context', async () => {
    convs.getConversation.mockResolvedValue(fullConv);
    convs.setPromoted.mockResolvedValue({ ...fullConv, promoted: true });
    cosService.addTask.mockResolvedValue({ id: 'task-1', status: 'pending' });

    const res = await request(makeApp())
      .post(`/api/ask/${convId}/turns/a1/promote`)
      .send({ target: 'task', priority: 'HIGH' });

    expect(res.status).toBe(200);
    expect(res.body.target).toBe('task');
    expect(res.body.ref).toEqual({ type: 'task', id: 'task-1' });
    expect(cosService.addTask).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'Block 30 minutes for deep work after lunch.',
        priority: 'HIGH',
        context: expect.stringContaining(convId),
      }),
      'user',
    );
  });

  it('truncates long assistant text when promoting to a CoS task', async () => {
    const longContent = 'x'.repeat(600);
    convs.getConversation.mockResolvedValue({
      ...fullConv,
      turns: [{ id: 'a1', role: 'assistant', content: longContent }],
    });
    convs.setPromoted.mockResolvedValue({ ...fullConv, promoted: true });
    cosService.addTask.mockResolvedValue({ id: 'task-2' });

    const res = await request(makeApp())
      .post(`/api/ask/${convId}/turns/a1/promote`)
      .send({ target: 'task' });

    expect(res.status).toBe(200);
    const description = cosService.addTask.mock.calls[0][0].description;
    expect(description.length).toBeLessThanOrEqual(280);
    expect(description.endsWith('…')).toBe(true);
  });

  it('returns 409 when the promoted task is a duplicate', async () => {
    convs.getConversation.mockResolvedValue(fullConv);
    cosService.addTask.mockResolvedValue({ id: 'task-existing', duplicate: true, status: 'pending' });

    const res = await request(makeApp())
      .post(`/api/ask/${convId}/turns/a1/promote`)
      .send({ target: 'task' });

    expect(res.status).toBe(409);
    expect(convs.setPromoted).not.toHaveBeenCalled();
  });

  it('promotes an assistant turn to a goal progress entry', async () => {
    convs.getConversation.mockResolvedValue(fullConv);
    convs.setPromoted.mockResolvedValue({ ...fullConv, promoted: true });
    identityService.addProgressEntry.mockResolvedValue({ id: 'prog-1', date: '2026-04-28', note: 'x' });

    const res = await request(makeApp())
      .post(`/api/ask/${convId}/turns/a1/promote`)
      .send({ target: 'goal', goalId: 'goal-123' });

    expect(res.status).toBe(200);
    expect(res.body.ref).toEqual({ type: 'goal', id: 'goal-123', entryId: 'prog-1' });
    expect(identityService.addProgressEntry).toHaveBeenCalledWith(
      'goal-123',
      expect.objectContaining({ note: 'Block 30 minutes for deep work after lunch.', durationMinutes: null }),
    );
  });

  it('404s when the goal does not exist', async () => {
    convs.getConversation.mockResolvedValue(fullConv);
    identityService.addProgressEntry.mockResolvedValue(null);

    const res = await request(makeApp())
      .post(`/api/ask/${convId}/turns/a1/promote`)
      .send({ target: 'goal', goalId: 'missing-goal' });

    expect(res.status).toBe(404);
    expect(convs.setPromoted).not.toHaveBeenCalled();
  });

  it('rejects promoting a user turn', async () => {
    convs.getConversation.mockResolvedValue(fullConv);

    const res = await request(makeApp())
      .post(`/api/ask/${convId}/turns/u1/promote`)
      .send({ target: 'brain' });

    expect(res.status).toBe(400);
    expect(brainService.captureThought).not.toHaveBeenCalled();
  });

  it('404s when the turn id is not in the conversation', async () => {
    convs.getConversation.mockResolvedValue(fullConv);

    const res = await request(makeApp())
      .post(`/api/ask/${convId}/turns/missing/promote`)
      .send({ target: 'brain' });

    expect(res.status).toBe(404);
  });

  it('rejects promoting an empty turn', async () => {
    convs.getConversation.mockResolvedValue({
      ...fullConv,
      turns: [{ id: 'a1', role: 'assistant', content: '   ' }],
    });

    const res = await request(makeApp())
      .post(`/api/ask/${convId}/turns/a1/promote`)
      .send({ target: 'brain' });

    expect(res.status).toBe(400);
  });

  it('404s when the conversation does not exist', async () => {
    convs.getConversation.mockResolvedValue(null);

    const res = await request(makeApp())
      .post(`/api/ask/${convId}/turns/a1/promote`)
      .send({ target: 'brain' });

    expect(res.status).toBe(404);
  });

  it('rejects unknown promotion targets', async () => {
    const res = await request(makeApp())
      .post(`/api/ask/${convId}/turns/a1/promote`)
      .send({ target: 'mars' });

    expect(res.status).toBe(400);
  });

  it('rejects goal target without goalId', async () => {
    const res = await request(makeApp())
      .post(`/api/ask/${convId}/turns/a1/promote`)
      .send({ target: 'goal' });

    expect(res.status).toBe(400);
  });
});

describe('POST /api/ask (validation)', () => {
  it('rejects empty questions', async () => {
    const res = await request(makeApp())
      .post('/api/ask')
      .send({ question: '   ' });
    expect(res.status).toBe(400);
  });

  it('rejects unknown modes', async () => {
    const res = await request(makeApp())
      .post('/api/ask')
      .send({ question: 'hi', mode: 'shout' });
    expect(res.status).toBe(400);
  });

  it('rejects malformed conversationIds', async () => {
    const res = await request(makeApp())
      .post('/api/ask')
      .send({ question: 'hi', conversationId: 'not-an-id' });
    expect(res.status).toBe(400);
  });

  it('404s when conversationId is well-formed but unknown', async () => {
    convs.getConversation.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/ask')
      .send({ question: 'hi', conversationId: 'ask_lwg2x4abc_aaaaaaaa' });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/ask (streaming happy path)', () => {
  it('streams open → sources → delta → done as SSE', async () => {
    convs.createConversation.mockResolvedValue({ id: 'ask_lwgnewabc_abcdef00', mode: 'ask', turns: [] });
    convs.appendTurn.mockImplementation((id, turn) => Promise.resolve({
      conversation: { id, mode: 'ask', turns: [{ ...turn, id: 'tid' }] },
      turn: { ...turn, id: 'tid' },
    }));
    // runAsk is async-iterable — emit a deterministic event sequence.
    svc.runAsk.mockImplementation(async function* () {
      yield { type: 'sources', sources: [{ kind: 'memory', id: 'memory:1', title: 'a', snippet: 'b' }] };
      yield { type: 'delta', text: 'Hi ' };
      yield { type: 'delta', text: 'there.' };
      yield { type: 'done', answer: 'Hi there.', sources: [], providerId: 'fake', model: 'm' };
    });

    const res = await request(makeApp())
      .post('/api/ask')
      .send({ question: 'hello' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type'] || '').toMatch(/text\/event-stream/);
    // testHelper buffers the whole body — assert event ordering and payloads
    // by string matching rather than parsing each frame.
    const body = res.text || '';
    expect(body).toContain('event: open');
    expect(body).toContain('"conversationId":"ask_lwgnewabc_abcdef00"');
    expect(body).toContain('event: sources');
    expect(body).toContain('event: delta');
    expect(body).toContain('"text":"Hi "');
    expect(body).toContain('event: done');

    // The user turn must be persisted before streaming begins, and the
    // assistant turn after the stream closes — assert both happened.
    const roles = convs.appendTurn.mock.calls.map((c) => c[1].role);
    expect(roles).toContain('user');
    expect(roles).toContain('assistant');
  });
});
