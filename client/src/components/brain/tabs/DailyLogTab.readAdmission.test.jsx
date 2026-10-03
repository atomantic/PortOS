import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { awaitPageLoaded } from '../../../test/pageLoadBarrier';
import { __resetVisibilityEventForTests } from '../../../hooks/useVisibilityEvent';

const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }));
vi.mock('../../ui/Toast', () => ({ default: toast }));
vi.mock('../../../services/voiceClient', () => ({
  onVoiceEvent: () => () => {}, sendText: vi.fn(), setDictation: vi.fn(),
}));
// Exercise the real GET/PUT wrappers and request error handling. Other regions
// are inert so no request can reach a live journal, provider, or database.
vi.mock('../../../services/api', async () => {
  const { getDailyLog, updateDailyLog } = await import('../../../services/apiBrain');
  return {
    getDailyLog, updateDailyLog,
    listDailyLogs: async () => ({ records: [] }),
    getDailyLogSettings: async () => ({}),
    getActivityDigestSettings: async () => ({}),
    getProviders: async () => ({ providers: [] }),
  };
});
vi.mock('../../../services/apiNotes', () => ({ getNotesVaults: async () => [] }));
const DailyLogTab = (await import('./DailyLogTab')).default;
const DAY = '2000-01-02';
const PREVIOUS = '2000-01-01';
const inventedEntry = (date, content = 'Invented journal text') => ({
  date, content, updatedAt: `${date}T12:00:00Z`, segments: [],
});
const response = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});
let read;
let transport;
const writes = () => transport.mock.calls.filter(([, options]) => options.method === 'PUT');
const reads = (date) => transport.mock.calls.filter(([url]) => url === `/api/brain/daily-log/${date}`);
const editor = () => screen.getByRole('textbox', { name: 'Log entry' });
const mount = async () => {
  const result = render(<MemoryRouter initialEntries={[`/?date=${DAY}`]}><DailyLogTab /></MemoryRouter>);
  await awaitPageLoaded('Loading');
  vi.useFakeTimers();
  return result;
};
const settle = async (action) => act(async () => { action(); await vi.advanceTimersByTimeAsync(0); });
const background = () => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  document.dispatchEvent(new Event('visibilitychange'));
};

beforeEach(() => {
  vi.clearAllMocks();
  read = async (date) => response({ date, entry: inventedEntry(date) });
  transport = vi.fn(async (url, options) => {
    const date = url.split('/').at(-1);
    if (options.method === 'PUT') {
      const { content } = JSON.parse(options.body);
      return response({ date, entry: inventedEntry(date, content) });
    }
    if (date === 'today') return response({ date: DAY, entry: null });
    return read(date);
  });
  vi.stubGlobal('fetch', transport);
});
afterEach(() => {
  vi.useRealTimers();
  __resetVisibilityEventForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Daily Log replacement read admission through intercepted transport', () => {
  it('refuses every save trigger after an initial 503, then retries once and saves with the recovered version', async () => {
    read = async () => response({ error: 'Synthetic unavailable' }, 503);
    const { unmount } = await mount();
    expect(screen.getByRole('alert')).toHaveTextContent('Daily log unavailable');
    expect(editor()).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(toast.error).not.toHaveBeenCalled();
    fireEvent.change(editor(), { target: { value: 'Invented replacement' } });
    fireEvent.keyDown(editor(), { key: 's', ctrlKey: true });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.blur(editor());
    await settle(background);
    await act(async () => { await vi.advanceTimersByTimeAsync(11000); });
    expect(writes()).toHaveLength(0);

    let release;
    read = () => new Promise((resolve) => { release = resolve; });
    const retry = screen.getByRole('button', { name: 'Retry' });
    await settle(() => { fireEvent.click(retry); fireEvent.click(retry); });
    expect(reads(DAY)).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await settle(background);
    expect(writes()).toHaveLength(0);
    await settle(() => release(response({ date: DAY, entry: inventedEntry(DAY) })));
    expect(editor()).not.toHaveAttribute('readonly');
    expect(editor()).toHaveValue('Invented journal text');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.change(editor(), { target: { value: 'Recovered edit' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    expect(writes()).toHaveLength(1);
    expect(JSON.parse(writes()[0][1].body)).toEqual({
      content: 'Recovered edit', ifMatchUpdatedAt: `${DAY}T12:00:00Z`,
    });
    unmount();
  });

  it('does not flush an unresolved failed day on unmount', async () => {
    read = async () => { throw new Error('Synthetic disconnected transport'); };
    const { unmount } = await mount();
    fireEvent.change(editor(), { target: { value: 'Invented replacement' } });
    await settle(unmount);
    expect(writes()).toHaveLength(0);
  });

  it('preserves the last good buffer when a refresh fails and restores editing on Retry', async () => {
    await mount();
    read = async () => response({ error: 'Synthetic unavailable' }, 503);
    await settle(() => fireEvent.click(screen.getByRole('button', { name: 'Refresh entry' })));
    expect(editor()).toHaveValue('Invented journal text');
    expect(editor()).toHaveAttribute('readonly');
    expect(screen.getByRole('alert')).toHaveTextContent('autosave are paused');
    fireEvent.change(editor(), { target: { value: 'Ignored change' } });
    await settle(background);
    expect(writes()).toHaveLength(0);
    read = async (date) => response({ date, entry: inventedEntry(date, 'Recovered server text') });
    await settle(() => fireEvent.click(screen.getByRole('button', { name: 'Retry' })));
    expect(editor()).toHaveValue('Recovered server text');
    expect(editor()).not.toHaveAttribute('readonly');
  });

  it('blocks dirty previous-day flushes after a failed switch and ignores a superseded Retry response', async () => {
    await mount();
    fireEvent.change(editor(), { target: { value: 'Unsaved invented previous-day text' } });
    read = async () => response({ error: 'Synthetic unavailable' }, 503);
    await settle(() => fireEvent.click(screen.getByRole('button', { name: 'Previous day' })));
    expect(editor()).toHaveValue('');
    expect(editor()).toHaveAttribute('readonly');
    fireEvent.blur(editor());
    await settle(background);
    await act(async () => { await vi.advanceTimersByTimeAsync(11000); });
    expect(writes()).toHaveLength(0);
    let release;
    read = (date) => date === PREVIOUS
      ? new Promise((resolve) => { release = resolve; })
      : Promise.resolve(response({ date, entry: inventedEntry(date, 'Selected-day text') }));
    await settle(() => fireEvent.click(screen.getByRole('button', { name: 'Retry' })));
    await settle(() => fireEvent.click(screen.getByRole('button', { name: 'Next day' })));
    expect(editor()).toHaveValue('Selected-day text');
    await settle(() => release(response({ date: PREVIOUS, entry: inventedEntry(PREVIOUS, 'Superseded text') })));
    expect(editor()).toHaveValue('Selected-day text');
    expect(editor()).not.toHaveAttribute('readonly');
    expect(writes()).toHaveLength(0);
  });

  it('admits creation after a successful explicit null entry', async () => {
    read = async (date) => response({ date, entry: null });
    await mount();
    expect(editor()).not.toHaveAttribute('readonly');
    fireEvent.change(editor(), { target: { value: 'Invented new day' } });
    fireEvent.blur(editor());
    await settle(() => {});
    expect(writes()).toHaveLength(1);
    expect(JSON.parse(writes()[0][1].body)).toEqual({ content: 'Invented new day' });
  });

  it.each([
    { date: DAY },
    { date: PREVIOUS, entry: inventedEntry(PREVIOUS) },
    { date: DAY, entry: { date: DAY, content: 'Missing version' } },
    { date: DAY, entry: { ...inventedEntry(DAY), content: null } },
  ])('refuses malformed or wrong-owner successful responses: %j', async (body) => {
    read = async () => response(body);
    await mount();
    expect(editor()).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(writes()).toHaveLength(0);
  });
});
