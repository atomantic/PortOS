import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { __resetVisibilityEventForTests } from '../../../hooks/useVisibilityEvent';

// ── Mock toast ────────────────────────────────────────────────────────────────
const mockToast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }));
vi.mock('../../ui/Toast', () => ({ default: mockToast }));

// ── Mock voice client — capture handlers so tests can fire server events ──────
const voice = vi.hoisted(() => ({
  handlers: {},
  onVoiceEvent: vi.fn(),
  sendText: vi.fn(),
  setDictation: vi.fn(),
}));
voice.onVoiceEvent.mockImplementation((event, fn) => {
  voice.handlers[event] = fn;
  return () => { delete voice.handlers[event]; };
});
vi.mock('../../../services/voiceClient', () => ({
  onVoiceEvent: voice.onVoiceEvent,
  sendText: voice.sendText,
  setDictation: voice.setDictation,
}));

// ── Mock API ──────────────────────────────────────────────────────────────────
const api = vi.hoisted(() => ({
  getDailyLog: vi.fn(),
  listDailyLogs: vi.fn(),
  getDailyLogSettings: vi.fn(),
  updateDailyLogSettings: vi.fn(),
  getActivityDigestSettings: vi.fn(),
  updateActivityDigestSettings: vi.fn(),
  getProviders: vi.fn(),
  updateDailyLog: vi.fn(),
  appendDailyLog: vi.fn(),
  deleteDailyLog: vi.fn(),
  syncDailyLogsToObsidian: vi.fn(),
  draftActivityDigest: vi.fn(),
}));
vi.mock('../../../services/api', () => api);
vi.mock('../../../services/apiNotes', () => ({ getNotesVaults: vi.fn(async () => []) }));

const DailyLogTab = (await import('./DailyLogTab')).default;

const TODAY = '2026-07-17';
const YESTERDAY = '2026-07-16';
// Mirrors AUTOSAVE_MAX_WAIT_MS in the component.
const AUTOSAVE_MAX_WAIT_MS = 10000;

// Mirrors the server: setJournalContent stores `content` verbatim and echoes
// the persisted entry back.
const entryFor = (date, content) => ({
  date,
  content,
  segments: content ? [{ text: content, at: `${date}T12:00:00Z`, source: 'edit' }] : [],
  segmentCount: content ? 1 : 0,
  updatedAt: `${date}T12:00:00Z`,
  obsidianPath: null,
});

let store;

const renderTab = async () => {
  const result = render(<DailyLogTab />);
  // Flush the mount fetches (entry + server-today + history + settings).
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  return result;
};

// The placeholder differs per day and the textarea unmounts behind the loading
// spinner, so select the element itself — there is exactly one.
const editor = () => document.querySelector('textarea');

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(`${TODAY}T12:00:00`));
  store = { [TODAY]: entryFor(TODAY, 'existing'), [YESTERDAY]: entryFor(YESTERDAY, 'old day') };

  api.getDailyLog.mockImplementation(async (d) => {
    const date = d === 'today' ? TODAY : d;
    return { date, entry: store[date] || null };
  });
  api.updateDailyLog.mockImplementation(async (date, content) => ({ date, entry: entryFor(date, content) }));
  api.listDailyLogs.mockResolvedValue({ records: [] });
  api.getDailyLogSettings.mockResolvedValue({});
  api.getActivityDigestSettings.mockResolvedValue({});
  api.getProviders.mockResolvedValue({ providers: [] });
});

afterEach(() => {
  vi.useRealTimers();
  // The visibility hook is singleton-backed, and the visibilityState spy is a
  // real getter override — both leak into later tests if not undone.
  __resetVisibilityEventForTests();
  vi.restoreAllMocks();
});

const backgroundTab = async () => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
  });
};

// Put the editor into the parked state: unsaved typed edits, then a dictated
// segment lands server-side. Delivered in its own act() so React commits the
// state before any timer advances — as the real socket event does.
const typeThenReceiveVoiceSegment = async (typed) => {
  fireEvent.change(editor(), { target: { value: typed } });
  await act(async () => {
    voice.handlers['voice:dailyLog:appended']({
      date: TODAY,
      text: 'spoken words',
      segment: { text: 'spoken words', at: `${TODAY}T12:01:00Z`, source: 'voice' },
      segmentCount: 2,
      updatedAt: `${TODAY}T12:01:00Z`,
    });
  });
};

describe('DailyLogTab autosave', () => {
  it('saves after the user stops typing', async () => {
    await renderTab();
    fireEvent.change(editor(), { target: { value: 'a new thought' } });

    // Still within the debounce window — nothing sent yet.
    await act(async () => { await vi.advanceTimersByTimeAsync(1400); });
    expect(api.updateDailyLog).not.toHaveBeenCalled();

    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(api.updateDailyLog).toHaveBeenCalledTimes(1);
    expect(api.updateDailyLog).toHaveBeenCalledWith(TODAY, 'a new thought', { silent: true });
  });

  it('coalesces a burst of keystrokes into one save', async () => {
    await renderTab();
    for (const value of ['a', 'ab', 'abc', 'abcd']) {
      fireEvent.change(editor(), { target: { value } });
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    }
    expect(api.updateDailyLog).not.toHaveBeenCalled();

    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    expect(api.updateDailyLog).toHaveBeenCalledTimes(1);
    expect(api.updateDailyLog).toHaveBeenCalledWith(TODAY, 'abcd', { silent: true });
  });

  it('still saves during an uninterrupted typing run (max-wait ceiling)', async () => {
    await renderTab();
    // Keep typing forever at a cadence below the debounce — a pure debounce
    // would never fire.
    for (let i = 0; i < 20; i += 1) {
      fireEvent.change(editor(), { target: { value: `word ${i}` } });
      await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    }
    expect(api.updateDailyLog).toHaveBeenCalled();
  });

  it('saves immediately on blur without waiting for the debounce', async () => {
    await renderTab();
    fireEvent.change(editor(), { target: { value: 'typed then left' } });
    fireEvent.blur(editor());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    expect(api.updateDailyLog).toHaveBeenCalledTimes(1);
    expect(api.updateDailyLog).toHaveBeenCalledWith(TODAY, 'typed then left', { silent: true });
  });

  it('saves when the tab is backgrounded', async () => {
    await renderTab();
    fireEvent.change(editor(), { target: { value: 'backgrounded' } });
    await backgroundTab();

    expect(api.updateDailyLog).toHaveBeenCalledWith(TODAY, 'backgrounded', { silent: true });
  });

  it('flushes on unmount so an edit inside the debounce window is not lost', async () => {
    const { unmount } = await renderTab();
    fireEvent.change(editor(), { target: { value: 'typed then navigated away' } });

    // Well inside the debounce window — the timer's own cleanup would drop it.
    await act(async () => { unmount(); await vi.advanceTimersByTimeAsync(0); });

    expect(api.updateDailyLog).toHaveBeenCalledWith(TODAY, 'typed then navigated away', { silent: true });
  });

  it('does not save when nothing changed', async () => {
    await renderTab();
    fireEvent.blur(editor());
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(api.updateDailyLog).not.toHaveBeenCalled();
  });

  it('autosaves silently — no success toast per tick', async () => {
    await renderTab();
    fireEvent.change(editor(), { target: { value: 'quiet' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });

    expect(api.updateDailyLog).toHaveBeenCalled();
    expect(mockToast.success).not.toHaveBeenCalled();
  });

  it('toasts once per failure run rather than on every retry', async () => {
    api.updateDailyLog.mockRejectedValue(new Error('offline'));
    await renderTab();

    for (const value of ['x', 'xy', 'xyz']) {
      fireEvent.change(editor(), { target: { value } });
      await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    }

    expect(api.updateDailyLog.mock.calls.length).toBeGreaterThan(1);
    expect(mockToast.error).toHaveBeenCalledTimes(1);
  });

  it('keeps debouncing after a failure instead of PUTting per keystroke', async () => {
    api.updateDailyLog.mockRejectedValue(new Error('offline'));
    await renderTab();

    // Cross the max-wait ceiling with a failing server: if the ceiling anchor
    // only reset on success, `waited` would stay past it forever and every
    // later keystroke would fire an immediate PUT at the dead server.
    fireEvent.change(editor(), { target: { value: 'first' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTOSAVE_MAX_WAIT_MS + 2000); });
    api.updateDailyLog.mockClear();

    // Now type a burst — a healthy debounce coalesces it into nothing yet.
    for (const value of ['a', 'ab', 'abc', 'abcd', 'abcde']) {
      fireEvent.change(editor(), { target: { value } });
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    }
    expect(api.updateDailyLog).not.toHaveBeenCalled();

    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    expect(api.updateDailyLog).toHaveBeenCalledTimes(1);
  });

  it('keeps keystrokes typed while a save is in flight', async () => {
    let release;
    api.updateDailyLog.mockImplementation((date, content) => new Promise((resolve) => {
      release = () => resolve({ date, entry: entryFor(date, content) });
    }));
    await renderTab();

    fireEvent.change(editor(), { target: { value: 'first' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    expect(api.updateDailyLog).toHaveBeenCalledWith(TODAY, 'first', { silent: true });

    // Type while the PUT is still open, then let it resolve.
    fireEvent.change(editor(), { target: { value: 'first second' } });
    await act(async () => { release(); await vi.advanceTimersByTimeAsync(0); });

    // The server echoed 'first'; the textarea must not revert to it.
    expect(editor().value).toBe('first second');

    // ...and the newer text still reaches the server on the next tick.
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    expect(api.updateDailyLog).toHaveBeenLastCalledWith(TODAY, 'first second', { silent: true });
  });

  it('never writes one day\'s text into another after a date change', async () => {
    // Hold the YESTERDAY load open so `date` has flipped while `content` still
    // holds TODAY's text — the window the loadedDate guard protects.
    let releaseLoad;
    api.getDailyLog.mockImplementation((d) => {
      if (d === YESTERDAY) return new Promise((resolve) => { releaseLoad = () => resolve({ date: d, entry: store[d] }); });
      const date = d === 'today' ? TODAY : d;
      return Promise.resolve({ date, entry: store[date] || null });
    });
    await renderTab();

    fireEvent.change(editor(), { target: { value: "today's private text" } });
    fireEvent.click(screen.getByTitle('Previous day'));
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });

    // Autosave must stand down entirely while the target day is unresolved.
    expect(api.updateDailyLog).not.toHaveBeenCalled();

    await act(async () => { releaseLoad(); await vi.advanceTimersByTimeAsync(2000); });
    expect(api.updateDailyLog).not.toHaveBeenCalled();
    expect(editor().value).toBe('old day');
  });

  it('parks autosave when a dictated segment lands mid-edit', async () => {
    await renderTab();
    await typeThenReceiveVoiceSegment('my unsaved edit');
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });

    expect(api.updateDailyLog).not.toHaveBeenCalled();
    expect(screen.getByText(/Autosave paused/i)).toBeInTheDocument();

    // The explicit Save button is the user choosing their edits — it still works.
    fireEvent.click(screen.getByLabelText('Save'));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(api.updateDailyLog).toHaveBeenCalledWith(TODAY, 'my unsaved edit', { silent: true });
  });

  // The park has to hold for every automatic trigger, not just the timer —
  // blur and backgrounding reach the same PUT that would drop the segment.
  it('parks the blur flush too', async () => {
    await renderTab();
    await typeThenReceiveVoiceSegment('my unsaved edit');

    fireEvent.blur(editor());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(api.updateDailyLog).not.toHaveBeenCalled();
  });

  it('parks the background flush too', async () => {
    await renderTab();
    await typeThenReceiveVoiceSegment('my unsaved edit');

    await backgroundTab();
    expect(api.updateDailyLog).not.toHaveBeenCalled();
  });

  it('lifts the park once the entry is re-adopted from the server', async () => {
    api.appendDailyLog.mockResolvedValue({ entry: entryFor(TODAY, 'server text') });
    await renderTab();
    await typeThenReceiveVoiceSegment('my unsaved edit');
    expect(screen.getByText(/Autosave paused/i)).toBeInTheDocument();

    // A quick-append adopts the server entry wholesale, resolving the divergence.
    fireEvent.change(screen.getByPlaceholderText(/Quick append/i), { target: { value: 'note' } });
    fireEvent.click(screen.getByText('Append'));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    // Otherwise the toolbar would tell the user to click a disabled Save button.
    expect(screen.queryByText(/Autosave paused/i)).not.toBeInTheDocument();
    expect(screen.getByText(/· Saved/)).toBeInTheDocument();

    // ...and the park is genuinely lifted, not merely hidden by `dirty` being
    // false: the next edit must autosave rather than stay parked forever.
    api.updateDailyLog.mockClear();
    fireEvent.change(editor(), { target: { value: 'server text plus more' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    expect(api.updateDailyLog).toHaveBeenCalledWith(TODAY, 'server text plus more', { silent: true });
  });

  it('resumes autosaving after the voice conflict is resolved', async () => {
    await renderTab();
    fireEvent.change(editor(), { target: { value: 'edit one' } });
    await act(async () => {
      voice.handlers['voice:dailyLog:appended']({ date: TODAY, text: 'spoken', segmentCount: 2 });
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(api.updateDailyLog).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText('Save'));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    api.updateDailyLog.mockClear();

    fireEvent.change(editor(), { target: { value: 'edit two' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    expect(api.updateDailyLog).toHaveBeenCalledWith(TODAY, 'edit two', { silent: true });
  });

  it('shows save status in the toolbar', async () => {
    await renderTab();
    expect(screen.getByText(/· Saved/)).toBeInTheDocument();

    fireEvent.change(editor(), { target: { value: 'dirty now' } });
    expect(screen.getByText(/· Unsaved…/)).toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    expect(screen.getByText(/· Saved/)).toBeInTheDocument();
  });
});
