import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';

vi.mock('../services/apiAsk.js', async (importOriginal) => ({
  ...(await importOriginal()),
  listAskConversations: vi.fn(async () => ({ conversations: [] })),
  getAskConversation: vi.fn(),
  promoteAskConversation: vi.fn(async (id, promoted) => ({ conversation: { id, promoted } })),
  promoteAskTurn: vi.fn(),
  streamAskTurn: vi.fn(async () => {}),
}));
vi.mock('../services/apiGoals.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getGoals: vi.fn(async () => ({ goals: [] })),
}));

import { getAskConversation, streamAskTurn, promoteAskConversation, promoteAskTurn } from '../services/apiAsk.js';
import { getGoals } from '../services/apiGoals.js';
import Ask from './Ask';

const conversation = (id, text, promoted = true) => ({
  conversation: {
    id,
    title: `Conversation ${id}`,
    mode: 'ask',
    promoted,
    turns: [{ id: `turn-${id}`, role: 'assistant', content: text }],
  },
});

describe('Ask across conversation route changes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('clears the previous transcript and mutation target while the next conversation loads', async () => {
    let resolveNext;
    getAskConversation.mockImplementation((id) => id === 'ask_111111111_aaaaaaaa'
      ? Promise.resolve(conversation(id, 'Private answer from A'))
      : new Promise((resolve) => { resolveNext = resolve; }));

    const router = createMemoryRouter(
      [{ path: '/ask/:conversationId', element: <Ask /> }],
      { initialEntries: ['/ask/ask_111111111_aaaaaaaa'] },
    );
    render(<RouterProvider router={router} />);

    expect(await screen.findByText('Private answer from A')).toBeInTheDocument();
    await act(() => router.navigate('/ask/ask_222222222_bbbbbbbb'));

    expect(screen.queryByText('Private answer from A')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unpin conversation' })).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: 'Question' }), 'A question for B');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(streamAskTurn).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(streamAskTurn).not.toHaveBeenCalled();
    expect(promoteAskConversation).not.toHaveBeenCalled();

    await act(async () => resolveNext(conversation('ask_222222222_bbbbbbbb', 'Answer from B')));
    expect(await screen.findByText('Answer from B')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Unpin conversation' }));
    expect(promoteAskConversation).toHaveBeenCalledWith('ask_222222222_bbbbbbbb', false);
    await user.clear(screen.getByRole('textbox', { name: 'Question' }));
    await user.type(screen.getByRole('textbox', { name: 'Question' }), 'B question');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(streamAskTurn).toHaveBeenCalledWith(
      { conversationId: 'ask_222222222_bbbbbbbb', question: 'B question', mode: 'ask' },
      expect.any(Object),
    );
  });

  it('keeps optimistic turns visible while a new conversation is still pending its server ID', async () => {
    let emitEvent;
    let finishStream;
    streamAskTurn.mockImplementation((_payload, { onEvent }) => {
      emitEvent = onEvent;
      return new Promise((resolve) => { finishStream = resolve; });
    });
    const router = createMemoryRouter(
      [{ path: '/ask/:conversationId?', element: <Ask /> }],
      { initialEntries: ['/ask'] },
    );
    render(<RouterProvider router={router} />);

    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: 'Question' }), 'A new question');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('A new question')).toBeInTheDocument();

    await act(async () => emitEvent({ event: 'open', data: { conversationId: 'ask_123456789_abcdef01' } }));
    expect(router.state.location.pathname).toBe('/ask/ask_123456789_abcdef01');
    expect(screen.getByText('A new question')).toBeInTheDocument();

    await act(async () => emitEvent({ event: 'delta', data: { text: 'An answer in progress' } }));
    expect(screen.getByText('A new question')).toBeInTheDocument();
    expect(screen.getByText('An answer in progress')).toBeInTheDocument();

    await act(async () => {
      emitEvent({ event: 'done', data: { turn: { id: 'assistant-turn', role: 'assistant', content: 'An answer in progress' } } });
      finishStream();
    });
    expect(screen.getByText('A new question')).toBeInTheDocument();
    expect(streamAskTurn).toHaveBeenCalledWith(
      { conversationId: undefined, question: 'A new question', mode: 'ask' },
      expect.any(Object),
    );
  });
});

describe('Ask attached goal pill', () => {
  it('navigates to the goal route when clicked', async () => {
    getGoals.mockResolvedValue({ goals: [{ id: 'goal 1', title: 'Ship it' }] });
    promoteAskTurn.mockResolvedValue({ ok: true, ref: { id: 'goal 1' } });
    getAskConversation.mockResolvedValue(conversation('ask_333333333_cccccccc', 'Answer C'));
    const router = createMemoryRouter(
      [{ path: '/ask/:conversationId', element: <Ask /> }, { path: '/digital-twin/goals', element: <div>Goals page</div> }],
      { initialEntries: ['/ask/ask_333333333_cccccccc'] },
    );
    render(<RouterProvider router={router} />);
    await screen.findByText('Answer C');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Attach to goal…' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Attach to goal' }), 'goal 1');
    const pill = await screen.findByRole('button', { name: /Attached: Ship it/ });
    expect(pill).toBeEnabled();
    await user.click(pill);
    expect(router.state.location.pathname).toBe('/digital-twin/goals');
    expect(router.state.location.search).toBe('?id=goal%201');
  });
});
