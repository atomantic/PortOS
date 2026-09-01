import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
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

const renderTab = async (initialEntries = ['/']) => {
  // Router context is required: the open day derives from the ?date= param.
  const result = render(<MemoryRouter initialEntries={initialEntries}><DailyLogTab /></MemoryRouter>);
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
  api.updateDailyLog.mockImplementation(async (date, content) => ({
    date,
    entry: { ...entryFor(date, content), updatedAt: `${date}T12:30:00Z` },
  }));
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

// Unsaved typed edits, then a dictated segment lands server-side. Delivered
// in its own act() so React commits state before any timer advances — as the
// real socket event does. The segment is merged into the textarea (no park).
const typeThenReceiveVoiceSegment = async (typed, spoken = 'spoken words') => {
  fireEvent.change(editor(), { target: { value: typed } });
  await act(async () => {
    voice.handlers['voice:dailyLog:appended']({
      date: TODAY,
      text: spoken,
      segment: { text: spoken, at: `${TODAY}T12:01:00Z`, source: 'voice' },
      segmentCount: 2,
      updatedAt: `${TODAY}T12:01:00Z`,
    });
  });
};

describe('DailyLogTab deep linking', () => {
  it('opens the day named by a ?date= param instead of today', async () => {
    await renderTab([`/?date=${YESTERDAY}`]);
    expect(api.getDailyLog).toHaveBeenCalledWith(YESTERDAY);
    expect(editor().value).toBe('old day');
  });

  it('ignores a malformed ?date= param and falls back to today', async () => {
    await renderTab(['/?date=not-a-date']);
    expect(editor().value).toBe('existing');
  });
});

describe('DailyLogTab autosave', () => {
  it('saves after the user stops typing', async () => {
    await renderTab();
    fireEvent.change(editor(), { target: { value: 'a new thought' } });

    // Still within the debounce window — nothing sent yet.
    await act(async () => { await vi.advanceTimersByTimeAsync(1400); });
    expect(api.updateDailyLog).not.toHaveBeenCalled();

    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(api.updateDailyLog).toHaveBeenCalledTimes(1);
    expect(api.updateDailyLog).toHaveBeenCalledWith(TODAY, 'a new thought', {
      silent: true,
      ifMatchUpdatedAt: `${TODAY}T12:00:00Z`,
    });
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
    expect(api.updateDailyLog).toHaveBeenCalledWith(TODAY, 'abcd', {
      silent: true,
      ifMatchUpdatedAt: `${TODAY}T12:00:00Z`,
    });
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
    expect(api.updateDailyLog).toHaveBeenCalledWith(TODAY, 'typed then left', {
      silent: true,
      ifMatchUpdatedAt: `${TODAY}T12:00:00Z`,
    });
  });

  it('saves when the tab is backgrounded', async () => {
    await renderTab();
    fireEvent.change(editor(), { target: { value: 'backgrounded' } });
    await backgroundTab();

    expect(api.updateDailyLog).toHaveBeenCalledWith(TODAY, 'backgrounded', {
      silent: true,
      ifMatchUpdatedAt: `${TODAY}T12:00:00Z`,
    });
  });

  it('flushes on unmount so an edit inside the debounce window is not lost', async () => {
    const { unmount } = await renderTab();
    fireEvent.change(editor(), { target: { value: 'typed then navigated away' } });

    // Well inside the debounce window — the timer's own cleanup would drop it.
    await act(async () => { unmount(); await vi.advanceTimersByTimeAsync(0); });

    expect(api.updateDailyLog).toHaveBeenCalledWith(TODAY, 'typed then navigated away', {
      silent: true,
      ifMatchUpdatedAt: `${TODAY}T12:00:00Z`,
    });
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

  it('does not re-attempt a failed body until the content changes', async () => {
    api.updateDailyLog.mockRejectedValue(new Error('offline'));
    await renderTab();

    fireEvent.change(editor(), { target: { value: 'stuck' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    expect(api.updateDailyLog).toHaveBeenCalledTimes(1);

    // Same body, server still down: the failure must not loop a silent PUT
    // per debounce tick (`saving` flipping false re-runs the effect).
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(api.updateDailyLog).toHaveBeenCalledTimes(1);

    // A keystroke changes the body and re-arms the autosave.
    fireEvent.change(editor(), { target: { value: 'stuck plus more' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    expect(api.updateDailyLog).toHaveBeenCalledTimes(2);

    // Once a save succeeds, the gate clears and normal autosave resumes.
    api.updateDailyLog.mockImplementation(async (date, content) => ({ date, entry: entryFor(date, content) }));
    fireEvent.change(editor(), { target: { value: 'recovered' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    expect(api.updateDailyLog).toHaveBeenCalledTimes(3);
    fireEvent.change(editor(), { target: { value: 'recovered again' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    expect(api.updateDailyLog).toHaveBeenCalledTimes(4);
  });

  it('keeps keystrokes typed while a save is in flight', async () => {
    let release;
    api.updateDailyLog.mockImplementation((date, content) => new Promise((resolve) => {
      release = () => resolve({
        date,
        entry: { ...entryFor(date, content), updatedAt: `${date}T12:30:00Z` },
      });
    }));
    await renderTab();

    fireEvent.change(editor(), { target: { value: 'first' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    expect(api.updateDailyLog).toHaveBeenCalledWith(TODAY, 'first', {
      silent: true,
      ifMatchUpdatedAt: `${TODAY}T12:00:00Z`,
    });

    // Type while the PUT is still open, then let it resolve.
    fireEvent.change(editor(), { target: { value: 'first second' } });
    await act(async () => { release(); await vi.advanceTimersByTimeAsync(0); });

    // The server echoed 'first'; the textarea must not revert to it.
    expect(editor().value).toBe('first second');

    // ...and the newer text still reaches the server on the next tick.
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    expect(api.updateDailyLog).toHaveBeenLastCalledWith(TODAY, 'first second', {
      silent: true,
      ifMatchUpdatedAt: `${TODAY}T12:30:00Z`,
    });
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

  it('merges a dictated segment into dirty text and keeps autosaving', async () => {
    await renderTab();
    await typeThenReceiveVoiceSegment('my unsaved edit', 'spoken words');

    // Textarea keeps typed text AND the new segment — no park, no toast gate.
    expect(editor().value).toBe('my unsaved edit\n\nspoken words');
    expect(screen.queryByText(/Autosave paused/i)).not.toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    expect(api.updateDailyLog).toHaveBeenCalledWith(
      TODAY,
      'my unsaved edit\n\nspoken words',
      { silent: true, ifMatchUpdatedAt: `${TODAY}T12:01:00Z` },
    );
  });

  it('blur flush after a mid-edit voice segment still saves the merge', async () => {
    await renderTab();
    await typeThenReceiveVoiceSegment('my unsaved edit', 'spoken words');

    fireEvent.blur(editor());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(api.updateDailyLog).toHaveBeenCalledWith(
      TODAY,
      'my unsaved edit\n\nspoken words',
      { silent: true, ifMatchUpdatedAt: `${TODAY}T12:01:00Z` },
    );
  });

  it('background flush after a mid-edit voice segment still saves the merge', async () => {
    await renderTab();
    await typeThenReceiveVoiceSegment('my unsaved edit', 'spoken words');

    await backgroundTab();
    expect(api.updateDailyLog).toHaveBeenCalledWith(
      TODAY,
      'my unsaved edit\n\nspoken words',
      { silent: true, ifMatchUpdatedAt: `${TODAY}T12:01:00Z` },
    );
  });

  it('retries a STALE_JOURNAL 409 by folding in the concurrent voice segment', async () => {
    const staleEntry = {
      date: TODAY,
      content: 'existing\n\nspoken mid-flight',
      segments: [
        { text: 'existing', at: `${TODAY}T12:00:00Z`, source: 'edit' },
        { text: 'spoken mid-flight', at: `${TODAY}T12:02:00Z`, source: 'voice' },
      ],
      segmentCount: 2,
      updatedAt: `${TODAY}T12:02:00Z`,
      obsidianPath: null,
    };
    let calls = 0;
    api.updateDailyLog.mockImplementation(async (date, content, _opts) => {
      calls += 1;
      if (calls === 1) {
        const err = new Error('Daily log was modified since you last loaded it');
        err.code = 'STALE_JOURNAL';
        err.status = 409;
        err.context = { entry: staleEntry };
        throw err;
      }
      return {
        date,
        entry: { ...entryFor(date, content), updatedAt: `${date}T12:03:00Z` },
      };
    });
    await renderTab();
    fireEvent.change(editor(), { target: { value: 'typed while speaking' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });

    // First attempt used the pre-append clock; retry merges the voice text
    // and re-PUTs against the server's new updatedAt.
    expect(api.updateDailyLog).toHaveBeenCalledTimes(2);
    expect(api.updateDailyLog.mock.calls[0]).toEqual([
      TODAY,
      'typed while speaking',
      { silent: true, ifMatchUpdatedAt: `${TODAY}T12:00:00Z` },
    ]);
    expect(api.updateDailyLog.mock.calls[1]).toEqual([
      TODAY,
      'typed while speaking\n\nspoken mid-flight',
      { silent: true, ifMatchUpdatedAt: `${TODAY}T12:02:00Z` },
    ]);
    // Textarea reflects the merged recovery (no further typing in this test).
    expect(editor().value).toBe('typed while speaking\n\nspoken mid-flight');
  });

  it('retries multiple STALE_JOURNAL 409s until a PUT lands', async () => {
    const stale1 = {
      date: TODAY,
      content: 'existing\n\nspoken-a',
      segments: [
        { text: 'existing', at: `${TODAY}T12:00:00Z`, source: 'edit' },
        { text: 'spoken-a', at: `${TODAY}T12:02:00Z`, source: 'voice' },
      ],
      segmentCount: 2,
      updatedAt: `${TODAY}T12:02:00Z`,
      obsidianPath: null,
    };
    const stale2 = {
      date: TODAY,
      content: 'existing\n\nspoken-a\n\nspoken-b',
      segments: [
        ...stale1.segments,
        { text: 'spoken-b', at: `${TODAY}T12:03:00Z`, source: 'voice' },
      ],
      segmentCount: 3,
      updatedAt: `${TODAY}T12:03:00Z`,
      obsidianPath: null,
    };
    let calls = 0;
    api.updateDailyLog.mockImplementation(async (date, content, _opts) => {
      calls += 1;
      if (calls === 1) {
        const err = new Error('Daily log was modified since you last loaded it');
        err.code = 'STALE_JOURNAL';
        err.status = 409;
        err.context = { entry: stale1 };
        throw err;
      }
      if (calls === 2) {
        const err = new Error('Daily log was modified since you last loaded it');
        err.code = 'STALE_JOURNAL';
        err.status = 409;
        err.context = { entry: stale2 };
        throw err;
      }
      return {
        date,
        entry: { ...entryFor(date, content), updatedAt: `${date}T12:04:00Z` },
      };
    });
    await renderTab();
    fireEvent.change(editor(), { target: { value: 'typed while speaking' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });

    expect(api.updateDailyLog).toHaveBeenCalledTimes(3);
    expect(api.updateDailyLog.mock.calls[0]).toEqual([
      TODAY,
      'typed while speaking',
      { silent: true, ifMatchUpdatedAt: `${TODAY}T12:00:00Z` },
    ]);
    expect(api.updateDailyLog.mock.calls[1]).toEqual([
      TODAY,
      'typed while speaking\n\nspoken-a',
      { silent: true, ifMatchUpdatedAt: `${TODAY}T12:02:00Z` },
    ]);
    expect(api.updateDailyLog.mock.calls[2]).toEqual([
      TODAY,
      'typed while speaking\n\nspoken-a\n\nspoken-b',
      { silent: true, ifMatchUpdatedAt: `${TODAY}T12:03:00Z` },
    ]);
    expect(editor().value).toBe('typed while speaking\n\nspoken-a\n\nspoken-b');
    expect(screen.queryByText(/Save failed/i)).not.toBeInTheDocument();
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

// The toolbar used to be one flat `flex-wrap` row of 11 controls, which spilled
// into 4+ stacked rows on a 375px viewport and pushed the textarea below the
// fold (#3526). jsdom has no layout engine, so these assert the structure that
// produces the two-row mobile toolbar rather than measured pixel heights.
describe('DailyLogTab mobile toolbar', () => {
  const toolbar = () => screen.getByLabelText('Save').closest('div.border-b');
  const openOverflow = () => {
    fireEvent.click(screen.getByRole('button', { name: 'More log actions' }));
    return screen.getByRole('menu', { name: 'More log actions' });
  };

  it('stacks into exactly two clusters under sm — date nav, then label + actions', async () => {
    await renderTab();
    const header = toolbar();

    // `flex-col` under sm keeps the clusters as two rows no matter how many
    // controls each holds; from sm up it collapses back to one wrapping row.
    expect(header.className).toContain('flex-col');
    expect(header.className).toContain('sm:flex-row');
    expect(header.children).toHaveLength(2);
  });

  it('demotes Draft / Read back / Delete out of the mobile row but keeps them on sm+', async () => {
    await renderTab();

    for (const label of ['Draft activity digest', 'Read back', 'Delete entry']) {
      expect(screen.getByLabelText(label).className).toContain('hidden sm:flex');
    }
    // Primary controls stay on the mobile row.
    for (const label of ['Save', 'Start dictation', 'Previous day', 'Next day']) {
      expect(screen.getByLabelText(label).className).not.toContain('hidden');
    }
    // ...and the overflow trigger is the mobile-only counterpart.
    expect(screen.getByRole('button', { name: 'More log actions' }).parentElement.className)
      .toContain('sm:hidden');
  });

  it('keeps every demoted action reachable from the overflow menu', async () => {
    await renderTab();
    const menu = openOverflow();

    for (const name of ['Draft activity digest', 'Read back', 'Delete entry']) {
      expect(within(menu).getByRole('menuitem', { name })).toBeTruthy();
    }
  });

  it('runs Read back from the overflow menu and closes it', async () => {
    await renderTab();
    const menu = openOverflow();

    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Read back' }));
    expect(voice.sendText).toHaveBeenCalledWith(expect.stringContaining('existing'));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('runs Draft from the overflow menu', async () => {
    api.draftActivityDigest.mockResolvedValue({ entry: entryFor(TODAY, 'drafted'), drafted: true });
    await renderTab();
    const menu = openOverflow();

    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Draft activity digest' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(api.draftActivityDigest).toHaveBeenCalledWith(TODAY, { silent: true });
  });

  it('opens the inline delete confirm from the overflow menu', async () => {
    await renderTab();
    const menu = openOverflow();

    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Delete entry' }));
    expect(screen.getByText(new RegExp(`Delete the entry for ${TODAY}`))).toBeInTheDocument();
  });

  it('closes the overflow menu on Escape', async () => {
    await renderTab();
    openOverflow();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
