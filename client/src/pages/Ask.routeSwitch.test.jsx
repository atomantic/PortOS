import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';

vi.mock('../services/api', async (importOriginal) => ({
  ...(await importOriginal()),
  listAskConversations: vi.fn(async () => ({ conversations: [] })),
  getAskConversation: vi.fn(),
  getGoals: vi.fn(async () => ({ goals: [] })),
  promoteAskConversation: vi.fn(async (id, promoted) => ({ conversation: { id, promoted } })),
  streamAskTurn: vi.fn(async () => {}),
}));

import * as api from '../services/api';
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
    api.getAskConversation.mockImplementation((id) => id === 'ask_111111111_aaaaaaaa'
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
    expect(api.streamAskTurn).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(api.streamAskTurn).not.toHaveBeenCalled();
    expect(api.promoteAskConversation).not.toHaveBeenCalled();

    await act(async () => resolveNext(conversation('ask_222222222_bbbbbbbb', 'Answer from B')));
    expect(await screen.findByText('Answer from B')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Unpin conversation' }));
    expect(api.promoteAskConversation).toHaveBeenCalledWith('ask_222222222_bbbbbbbb', false);
    await user.clear(screen.getByRole('textbox', { name: 'Question' }));
    await user.type(screen.getByRole('textbox', { name: 'Question' }), 'B question');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(api.streamAskTurn).toHaveBeenCalledWith(
      { conversationId: 'ask_222222222_bbbbbbbb', question: 'B question', mode: 'ask' },
      expect.any(Object),
    );
  });

  it('keeps optimistic turns visible while a new conversation is still pending its server ID', async () => {
    api.getAskConversation.mockResolvedValue(conversation('conv-a', 'Answer from A'));
    api.streamAskTurn.mockImplementation(async (_payload, { onEvent }) => {
      onEvent({ event: 'open', data: { conversationId: 'ask_123456789_abcdef01' } });
    });
    api.getAskConversation.mockImplementation(async (id) => id === 'ask_123456789_abcdef01'
      ? new Promise(() => {})
      : conversation('ask_111111111_aaaaaaaa', 'Answer from A'));
    const router = createMemoryRouter(
      [{ path: '/ask/:conversationId?', element: <Ask /> }],
      { initialEntries: ['/ask'] },
    );
    render(<RouterProvider router={router} />);

    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: 'Question' }), 'A new question');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(api.streamAskTurn).toHaveBeenCalledWith(
      { conversationId: undefined, question: 'A new question', mode: 'ask' },
      expect.any(Object),
    );
  });
});
