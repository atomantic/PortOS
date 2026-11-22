import { beforeEach, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import PersistentMindContextPanel from './PersistentMindContextPanel';
import { getPersistentMindContext, getPersistentMindReflection } from '../../services/apiAgents.js';

vi.mock('../../services/apiAgents.js', () => ({
  getPersistentMindContext: vi.fn(),
  getPersistentMindReflection: vi.fn(),
}));
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
  getPersistentMindContext.mockResolvedValue({ memories: [], prompt: {}, preview: {} });
  getPersistentMindReflection.mockResolvedValue({ state: 'pending', source, inspected: null });
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
  getPersistentMindReflection.mockResolvedValue({ state: 'empty', source: null, inspected: reviewed });
  await act(async () => { for (const handler of handlers.get('cos:memory:updated') || []) handler({ id: source.id }); });
  expect(await screen.findByText('Settled · learn', { exact: false })).toBeInTheDocument();
  expect(screen.getByText(/example-provider \/ example-model/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Linked lesson' })).toHaveAttribute('href', '/cos/memory/example-lesson');
  expect(getPersistentMindReflection).toHaveBeenLastCalledWith(expect.objectContaining({ silent: true }));
  unmount();
  expect(handlers.get('cos:memory:updated').size).toBe(0);
});

it('distinguishes a store failure from an honest empty reflection', async () => {
  getPersistentMindReflection.mockResolvedValue({ state: 'unavailable', source: null });
  render(<MemoryRouter><PersistentMindContextPanel view="context" /></MemoryRouter>);
  expect(await screen.findByText('Reflection unavailable')).toBeInTheDocument();
  expect(screen.queryByText('No eligible memory awaiting reflection.')).not.toBeInTheDocument();
  getPersistentMindReflection.mockResolvedValue({ state: 'empty', source: null });
  await act(async () => { for (const handler of handlers.get('cos:memory:updated') || []) handler({ id: source.id }); });
  await waitFor(() => expect(screen.getByText('No eligible memory awaiting reflection.')).toBeInTheDocument());
});

it('shows the mind-authored continuation note read-only with factual provenance', async () => {
  getPersistentMindReflection.mockResolvedValue({ state: 'empty', source: null });
  getPersistentMindContext.mockResolvedValue({ memories: [], prompt: {}, preview: { continuationNote: {
    state: 'omitted-budget', memoryId: 'note-1', version: 2, content: 'Next: read the reply.', updatedAt: '2026-01-02T00:00:00.000Z',
    provenance: { turnId: 'turn-7', providerId: 'provider-b', model: 'model-b', at: '2026-01-02T00:00:00.000Z' },
  } } });
  render(<MemoryRouter><PersistentMindContextPanel view="context" /></MemoryRouter>);
  const note = (await screen.findByRole('heading', { name: 'Continuation note' })).closest('section');
  expect(note).toHaveTextContent('Next: read the reply.');
  expect(note).toHaveTextContent('provider-b / model-b');
  expect(note).toHaveTextContent('turn turn-7');
  expect(note).toHaveTextContent('Omitted from this context');
  expect(note.querySelector('textarea, input, select, button')).toBeNull();
});

it('does not attribute an unattested note to the mind', async () => {
  getPersistentMindReflection.mockResolvedValue({ state: 'empty', source: null });
  getPersistentMindContext.mockResolvedValue({ memories: [], prompt: {}, preview: { continuationNote: {
    state: 'included', memoryId: 'note-1', version: 1, content: 'Legacy text', updatedAt: null, provenance: null,
  } } });
  render(<MemoryRouter><PersistentMindContextPanel view="context" /></MemoryRouter>);
  const note = (await screen.findByRole('heading', { name: 'Continuation note' })).closest('section');
  expect(note).toHaveTextContent('Author unknown');
  expect(note).not.toHaveTextContent('Written by the mind');
});

it('renders the context window breakdown bar, provenance badges and pin notice without polling', async () => {
  getPersistentMindReflection.mockResolvedValue({ state: 'empty', source: null });
  getPersistentMindContext.mockResolvedValue({
    memories: [], prompt: {}, preview: {},
    breakdown: {
      contextUsed: 9000, contextMax: 10000, contextPercent: 92, highOccupancy: true,
      occupancySource: 'local_estimate', windowSource: 'pinned',
      pinnedWindow: 10000, advertisedWindow: 131072, pinDisagreesWithAdvertised: true, promptCache: null,
      categories: [
        { id: 'identity', label: 'Identity', tokens: 100, percent: 1 },
        { id: 'tool_definitions', label: 'Tool definitions', tokens: 800, percent: 8, detail: [{ id: 'recipes', label: 'recipes', tokens: 700, tools: 2 }] },
        { id: 'free', label: 'Free headroom', tokens: 0, percent: 0 },
      ],
    },
  });
  render(<MemoryRouter><PersistentMindContextPanel view="context" /></MemoryRouter>);
  expect(await screen.findByText('Estimated')).toBeInTheDocument();
  expect(screen.getByText('Pinned window')).toBeInTheDocument();
  expect(screen.getByText(/differs from the model's advertised window/)).toBeInTheDocument();
  expect(screen.getByText('Context window nearly full')).toBeInTheDocument();
  expect(screen.getAllByText('Tool definitions').length).toBeGreaterThan(0);
  expect(screen.getByText(/recipes \(2 tools\)/)).toBeInTheDocument();
  expect(getPersistentMindContext).toHaveBeenCalledTimes(1);
});
