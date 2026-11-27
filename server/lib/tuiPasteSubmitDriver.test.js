import { UNSUBMITTED_PROMPT_SETTLE_MS } from '../test/fixtures/tuiTiming.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPasteSubmitDriver } from './tuiPasteSubmitDriver.js';
import {
  createPromptSubmissionGate,
  MCP_BOOT_PASTE_DEADLINE_MS,
  MCP_BOOT_PASTE_RETRY_DELAY_MS,
  PASTE_COMMIT_PATIENCE_MS,
  PASTE_RETRY_BASE_DELAY_MS,
  PASTE_TO_ENTER_FALLBACK_MS,
  PASTE_VERIFY_WINDOW_MS,
} from './tuiHandshake.js';

// The paste-and-submit contract both TUI runners share (#16105). Each case pins
// a behaviour the two runners used to implement separately and let drift.
const PROMPT = 'Refactor the billing module so invoices render in the account currency.';

function makeDriver(overrides = {}) {
  const state = { finalized: false };
  const write = vi.fn();
  const paste = vi.fn(() => 'enter-handle');
  const onFail = vi.fn();
  const onSubmitted = vi.fn();
  const events = [];
  const driver = createPasteSubmitDriver({
    prompt: PROMPT,
    command: 'example-tui',
    write,
    paste,
    isFinalized: () => state.finalized,
    onFail,
    onSubmitted,
    onEvent: (event) => events.push(event),
    ...overrides,
  });
  const pastes = () => write.mock.calls.filter(([keys]) => keys.startsWith('\x1b[200~')).length;
  const enters = () => write.mock.calls.filter(([keys]) => keys === '\r').length;
  return { driver, state, write, paste, onFail, onSubmitted, events, pastes, enters };
}

describe('createPasteSubmitDriver', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('submits as soon as the TUI paints its paste-commit marker', async () => {
    const { driver, write, onSubmitted, enters, events } = makeDriver();
    expect(driver.start('input-ready')).toBe(true);
    expect(write).toHaveBeenCalledWith(`\x1b[200~${PROMPT}\x1b[201~`);
    expect(events[0]).toEqual({ type: 'pasted', reason: 'input-ready', attempt: 1 });

    driver.ingest('[Pasted text #1 +3 lines]');
    await vi.advanceTimersByTimeAsync(300);
    expect(enters()).toBe(1);
    expect(write).toHaveBeenCalledWith('\r', { promptSubmission: true });
    expect(onSubmitted).toHaveBeenCalledTimes(1);
    // The remaining spaced Enters land; no duplicate submission is recorded.
    await vi.advanceTimersByTimeAsync(2000);
    expect(enters()).toBe(3);
    expect(onSubmitted).toHaveBeenCalledTimes(1);
    expect(driver.start('again')).toBe(false);
  });

  it('verifies a markerless paste by its rendered text before submitting', async () => {
    const { driver, enters, pastes } = makeDriver();
    driver.start('ready');
    await vi.advanceTimersByTimeAsync(PASTE_TO_ENTER_FALLBACK_MS + 200);
    expect(enters(), 'the commit wait elapsing is not proof the paste landed').toBe(0);
    driver.ingest(PROMPT); // the TUI renders the pasted text inline
    await vi.advanceTimersByTimeAsync(400);
    expect(enters()).toBe(1);
    expect(pastes()).toBe(1);
  });

  it('retries a swallowed paste, then fails paste-not-rendered once the budget is spent', async () => {
    const { driver, pastes, enters, onFail, events } = makeDriver();
    driver.start('ready');
    await vi.advanceTimersByTimeAsync(PASTE_TO_ENTER_FALLBACK_MS + PASTE_VERIFY_WINDOW_MS + 400);
    expect(events.at(-1)).toEqual({ type: 'paste-retrying', delayMs: PASTE_RETRY_BASE_DELAY_MS, mcpBootActive: false });
    await vi.advanceTimersByTimeAsync(PASTE_RETRY_BASE_DELAY_MS);
    expect(pastes()).toBe(2);
    expect(events.at(-1)).toEqual({ type: 'pasted', reason: 'ready', attempt: 2 });

    await vi.advanceTimersByTimeAsync(90_000);
    expect(enters()).toBe(0);
    expect(onFail).toHaveBeenCalledTimes(1);
    expect(onFail).toHaveBeenCalledWith('paste-not-rendered', expect.stringContaining('paste was silently swallowed'));
    expect(events.at(-1)).toMatchObject({ type: 'paste-not-rendered', mcpBootActive: false });
  });

  it('submits a paste whose marker paints during the retry backoff instead of re-pasting it', async () => {
    const { driver, pastes, enters } = makeDriver();
    driver.start('ready');
    await vi.advanceTimersByTimeAsync(PASTE_TO_ENTER_FALLBACK_MS + PASTE_VERIFY_WINDOW_MS + 400);
    driver.ingest('[Pasted text #1 +3 lines]');
    expect(enters()).toBe(1);
    await vi.advanceTimersByTimeAsync(PASTE_RETRY_BASE_DELAY_MS * 2);
    expect(pastes()).toBe(1);
  });

  it('keeps retrying on a time budget while codex boots its MCP servers', async () => {
    const mcpBoot = { active: true };
    const { driver, pastes, onFail, events } = makeDriver({ settleRule: 'codex', mcpBoot });
    driver.start('ready');
    await vi.advanceTimersByTimeAsync(PASTE_TO_ENTER_FALLBACK_MS + PASTE_VERIFY_WINDOW_MS + 400);
    expect(events.at(-1)).toEqual({ type: 'paste-retrying', delayMs: MCP_BOOT_PASTE_RETRY_DELAY_MS, mcpBootActive: true });
    await vi.advanceTimersByTimeAsync(MCP_BOOT_PASTE_DEADLINE_MS - 10_000);
    expect(onFail).not.toHaveBeenCalled();
    expect(pastes()).toBeGreaterThan(3);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(onFail).toHaveBeenCalledWith('paste-not-rendered', expect.stringContaining('MCP servers'));
  });

  describe("settleRule: 'codex'", () => {
    it('gives the first paste its patient commit window instead of re-pasting', async () => {
      const { driver, pastes, enters } = makeDriver({ settleRule: 'codex' });
      driver.start('ready');
      await vi.advanceTimersByTimeAsync(PASTE_COMMIT_PATIENCE_MS - 5000);
      expect(pastes()).toBe(1);
      driver.ingest('[Pasted Content 900 chars]');
      await vi.advanceTimersByTimeAsync(400);
      expect(enters()).toBe(1);
    });

    it('waits for paste output to settle before the Enter', async () => {
      const { driver, enters, pastes } = makeDriver({ settleRule: 'codex' });
      driver.start('ready');
      driver.ingest('[Pasted Content 900 chars]');
      for (let chunk = 0; chunk < 10; chunk += 1) {
        await vi.advanceTimersByTimeAsync(100);
        driver.ingest(' remaining prompt text');
      }
      expect(enters()).toBe(0);
      await vi.advanceTimersByTimeAsync(199);
      expect(enters()).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(enters()).toBe(1);
      expect(pastes()).toBe(1);
    });

    it('fails prompt-not-submitted when paste output never settles', async () => {
      const { driver, enters, pastes, onFail } = makeDriver({ settleRule: 'codex' });
      driver.start('ready');
      driver.ingest('[Pasted Content 900 chars]');
      for (let elapsed = 0; elapsed < PASTE_COMMIT_PATIENCE_MS + 1000; elapsed += 100) {
        await vi.advanceTimersByTimeAsync(100);
        driver.ingest(' continuing redraw');
      }
      expect(onFail).toHaveBeenCalledWith('prompt-not-submitted', 'Codex paste output never settled; no submission Enter was sent.');
      expect(enters()).toBe(0);
      expect(pastes()).toBe(1);
    });

    it('applies no settle delay without the codex rule', async () => {
      const { driver, enters } = makeDriver();
      driver.start('ready');
      driver.ingest('[Pasted text #1 +3 lines]');
      await vi.advanceTimersByTimeAsync(150);
      driver.ingest(' still redrawing');
      await vi.advanceTimersByTimeAsync(150);
      expect(enters()).toBe(1);
    });
  });

  it('stops every timer when the run finalizes mid-paste', async () => {
    const { driver, state, write, onFail } = makeDriver();
    driver.start('ready');
    state.finalized = true;
    driver.ingest('[Pasted text #1 +3 lines]');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(write).toHaveBeenCalledTimes(1); // the paste itself, nothing after
    expect(onFail).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancel() clears the submit Enters and the unsubmitted poll', async () => {
    const gate = createPromptSubmissionGate();
    const { driver, enters } = makeDriver({ promptGate: gate, unsubmittedPollMs: 1000 });
    driver.start('ready');
    driver.ingest('[Pasted text #1 +3 lines]');
    await vi.advanceTimersByTimeAsync(300);
    expect(enters()).toBe(1);
    driver.cancel();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails write-failed when the paste write throws', () => {
    const { driver, onFail } = makeDriver({ write: vi.fn(() => { throw new Error('PTY closed'); }) });
    expect(driver.start('ready'), 'a failed paste must not report delivery in flight').toBe(false);
    expect(onFail).toHaveBeenCalledWith('write-failed', 'Failed to write prompt: PTY closed');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('presses Enter again for a chip left unsubmitted, until the turn starts', async () => {
    let lastOutputAt = Date.now();
    const gate = createPromptSubmissionGate();
    const { driver, enters, events } = makeDriver({
      promptGate: gate, unsubmittedPollMs: 1000, getLastOutputAt: () => lastOutputAt,
    });
    driver.start('ready');
    driver.ingest('❯ [Pasted text #1 +40 lines]');
    lastOutputAt = Date.now();
    await vi.advanceTimersByTimeAsync(2000);
    const submitted = enters();
    await vi.advanceTimersByTimeAsync(UNSUBMITTED_PROMPT_SETTLE_MS + 1000);
    expect(enters()).toBe(submitted + 1);
    expect(events.at(-1)).toMatchObject({ type: 'unsubmitted-enter', attempt: 1 });
  });

  it('resubmits through the session paste and reports a gone session', () => {
    const { driver, paste } = makeDriver();
    expect(driver.resubmit({ label: 'nudge', text: 'continue' })).toBe(true);
    expect(paste).toHaveBeenCalledWith('continue', { label: 'nudge' });
    paste.mockReturnValueOnce(false);
    expect(driver.resubmit()).toBe(false);
    expect(paste).toHaveBeenLastCalledWith(PROMPT, { label: 'provider-handshake resubmit' });
  });
});
