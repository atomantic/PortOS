import { beforeEach, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import PersistentMindContextPanel from './PersistentMindContextPanel';
import * as api from '../../services/api';

vi.mock('../../services/api', () => ({ getPersistentMindContext: vi.fn(), getPersistentMindReflection: vi.fn() }));
vi.mock('./PersistentMindMaintainerControls', () => ({ default: () => null }));
const socket = vi.hoisted(() => ({ on: vi.fn(), off: vi.fn(), emit: vi.fn() }));
vi.mock('../../services/socket', () => ({ default: socket }));
const handlers = new Map();
const source = { id: 'example-source', version: 3, content: '  Exact source wording.  ', status: 'active', protection: 'standard' };

beforeEach(() => {
  vi.clearAllMocks();
  handlers.clear();
  socket.on.mockImplementation((event, handler) => {
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event).add(handler);
  });
  socket.off.mockImplementation((event, handler) => handlers.get(event)?.delete(handler));
  api.getPersistentMindContext.mockResolvedValue({ memories: [], prompt: {}, preview: {} });
  api.getPersistentMindReflection.mockResolvedValue({ state: 'pending', source, inspected: null });
});

it('shows inspect-only pending prose, then its real provenance and lesson after a memory event without polling', async () => {
  const { unmount } = render(<MemoryRouter><PersistentMindContextPanel view="context" /></MemoryRouter>);
  expect(await screen.findByText('Pending · optional', { exact: false })).toBeInTheDocument();
  expect(screen.getByText('Exact source wording.').textContent).toBe(source.content);
  expect(screen.getByRole('link', { name: 'Source memory' })).toHaveAttribute('href', '/cos/memory/example-source');
  expect(screen.queryByRole('button', { name: /review|retire|archive/i })).not.toBeInTheDocument();
  const reviewed = { ...source, lastReview: { expectedVersion: 3, latestVerdict: 'learn', outcomes: { learn: {
    expectedVersion: 3, verdict: 'learn', lessonId: 'example-lesson', lesson: 'The mind wrote this lesson.',
    providerId: 'example-provider', model: 'example-model', reviewedAt: '2026-01-01T12:00:00.000Z'
  } } } };
  api.getPersistentMindReflection.mockResolvedValue({ state: 'empty', source: null, inspected: reviewed });
  await act(async () => { for (const handler of handlers.get('cos:memory:updated') || []) handler({ id: source.id }); });
  expect(await screen.findByText('Settled · learn', { exact: false })).toBeInTheDocument();
  expect(screen.getByText(/example-provider \/ example-model/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Linked lesson' })).toHaveAttribute('href', '/cos/memory/example-lesson');
  expect(api.getPersistentMindReflection).toHaveBeenLastCalledWith(expect.objectContaining({ silent: true }));
  unmount();
  expect(handlers.get('cos:memory:updated').size).toBe(0);
});

it('distinguishes a store failure from an honest empty reflection', async () => {
  api.getPersistentMindReflection.mockResolvedValue({ state: 'unavailable', source: null });
  render(<MemoryRouter><PersistentMindContextPanel view="context" /></MemoryRouter>);
  expect(await screen.findByText('Reflection unavailable')).toBeInTheDocument();
  expect(screen.queryByText('No eligible memory awaiting reflection.')).not.toBeInTheDocument();
  api.getPersistentMindReflection.mockResolvedValue({ state: 'empty', source: null });
  await act(async () => { for (const handler of handlers.get('cos:memory:updated') || []) handler({ id: source.id }); });
  await waitFor(() => expect(screen.getByText('No eligible memory awaiting reflection.')).toBeInTheDocument());
});
