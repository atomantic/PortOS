import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { TERMINAL_DEL as DEL, planFieldEdit, attachDictationBridge } from './terminalDictation.js';

// Replay an emitted terminal-input stream the way a line editor would, so a test
// can assert "the prompt ends up holding what was dictated" rather than pinning
// the exact byte sequence that gets it there.
const render = (chunks) => chunks.join('').split('').reduce(
  (acc, ch) => (ch === DEL ? acc.slice(0, -1) : acc + ch),
  '',
);

describe('planFieldEdit', () => {
  const data = (...args) => planFieldEdit(...args).data;

  it('emits nothing when the field did not change', () => {
    expect(data('hello', 'hello')).toBe('');
  });

  it('emits only the appended text when the field grew', () => {
    expect(data('determin', 'determines')).toBe('es');
  });

  it('erases the replaced tail before retyping it', () => {
    expect(data('their', 'there')).toBe(`${DEL}${DEL}re`);
  });

  it('emits pure deletions when the field shrank', () => {
    expect(data('hello', 'hell')).toBe(DEL);
    expect(data('hello', '')).toBe(DEL.repeat(5));
  });

  it('never rewinds below the floor — it retypes instead of eating prior text', () => {
    // 'ls ' reached the PTY as keystrokes (floor 3); only 'foo' is ours.
    expect(data('ls foo', 'ls bar', 3)).toBe(`${DEL.repeat(3)}bar`);
    // Divergence below the floor: retype from the floor, delete nothing under it.
    expect(data('ls foo', 'xx bar', 3)).toBe(`${DEL.repeat(3)}bar`);
    // A floor past the end of the mirror clamps instead of emitting a negative run.
    expect(data('ab', 'abc', 99)).toBe('c');
  });

  it('reports what the PTY holds, which is not the field when the floor blocked a rewind', () => {
    // Normally the PTY ends up holding exactly what the field shows.
    expect(planFieldEdit('their', 'there').committed).toBe('there');
    // But 'ls ' is below the floor and was never rewound, so the PTY holds
    // 'ls bar' even though the field reads 'xx bar'. Tracking the field here
    // would make every later diff rewind against a baseline that never existed.
    expect(planFieldEdit('ls foo', 'xx bar', 3).committed).toBe('ls bar');
  });

  it('does not split a surrogate pair', () => {
    // 😀 and 😂 share a high surrogate; cutting between the halves would send a
    // lone surrogate, which serializes to U+FFFD instead of the emoji.
    const plan = planFieldEdit('hi 😀', 'hi 😂');
    expect(plan.committed).toBe('hi 😂');
    expect([...plan.data].every((ch) => ch.charCodeAt(0) < 0xd800 || ch.codePointAt(0) > 0xffff)).toBe(true);
  });

  it('erases one DEL per code point, not per UTF-16 unit', () => {
    // The far end erases a whole character per DEL. Counting JS string length
    // would send two for one emoji and eat the space before it.
    expect(planFieldEdit('hi 😀', 'hi ').data).toBe(DEL);
    expect(planFieldEdit('hi 😀', 'hi 😂').data).toBe(`${DEL}😂`);
    expect(planFieldEdit('a😀b😀', 'a').data).toBe(DEL.repeat(3));
  });
});

describe('attachDictationBridge', () => {
  let container;
  let textarea;
  let terminal;
  let sent;
  let dispose;

  // Faithful to what a browser dispatches: dictation/soft-keyboard edits arrive
  // as InputEvents carrying inputType, and the field value is already updated.
  const fireInput = (inputType, data = null) => {
    textarea.dispatchEvent(new InputEvent('input', { inputType, data, bubbles: true }));
  };

  // Key events the latch reads. 84 is 'T' — a capital, the case this bridge exists
  // for, so the tests that don't care about the specific key take it by default.
  const fireKey = (type, keyCode = 84) => {
    textarea.dispatchEvent(new KeyboardEvent(type, { keyCode, bubbles: true }));
  };

  // Stands in for xterm's own textarea listener, which appends the raw insertion.
  const attachXtermStub = () => {
    const spy = vi.fn();
    textarea.addEventListener('input', spy);
    return spy;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    textarea = document.createElement('textarea');
    container.appendChild(textarea);
    document.body.appendChild(container);
    terminal = { element: container, textarea, options: {} };
    sent = [];
    dispose = attachDictationBridge(terminal, (d) => { sent.push(d); });
  });

  afterEach(() => {
    dispose();
    container.remove();
    vi.useRealTimers();
  });

  it('does not attach or throw when the terminal has no DOM yet', () => {
    expect(() => attachDictationBridge({}, () => {})()).not.toThrow();
    expect(() => attachDictationBridge(terminal, null)()).not.toThrow();
  });

  it('forwards a streaming dictation phrase without duplicating it', () => {
    // Exactly the reported failure: Apple dictation rewrites its own guess.
    for (const partial of ['dde', 'deter', 'determin', 'determine', 'determines', 'determines if any code']) {
      textarea.value = partial;
      fireInput('insertText');
    }
    expect(render(sent)).toBe('determines if any code');
  });

  it('stops the event before xterm can append the raw insertion', () => {
    const xterm = attachXtermStub();
    textarea.value = 'hi';
    fireInput('insertText');
    expect(xterm).not.toHaveBeenCalled();
    expect(sent).toEqual(['hi']);
  });

  it('translates a dictation replacement into erase + retype', () => {
    textarea.value = 'their';
    fireInput('insertText');
    textarea.value = 'there';
    fireInput('insertReplacementText');
    expect(sent).toEqual(['their', `${DEL}${DEL}re`]);
  });

  it('forwards soft-keyboard deletions', () => {
    textarea.value = 'abc';
    fireInput('insertText');
    textarea.value = 'ab';
    fireInput('deleteContentBackward');
    textarea.value = '';
    fireInput('deleteWordBackward');
    expect(sent).toEqual(['abc', DEL, DEL.repeat(2)]);
  });

  it('leaves unowned input types to xterm and resyncs the mirror', () => {
    const xterm = attachXtermStub();
    textarea.value = 'pasted';
    fireInput('insertFromPaste');
    expect(sent).toEqual([]);
    expect(xterm).toHaveBeenCalledTimes(1);
    // The paste is now part of the untouchable floor: a later dictation appends
    // rather than erasing text xterm already sent.
    textarea.value = 'pasted more';
    fireInput('insertText');
    expect(sent).toEqual([' more']);
  });

  it('ignores input that belongs to an in-progress composition', () => {
    const xterm = attachXtermStub();
    textarea.value = 'か';
    textarea.dispatchEvent(new InputEvent('input', {
      inputType: 'insertCompositionText', data: 'か', isComposing: true, bubbles: true,
    }));
    expect(sent).toEqual([]);
    expect(xterm).toHaveBeenCalledTimes(1);
  });

  it('forwards dictation in screen-reader mode', () => {
    // xterm ignores every insertText in this mode, so the bridge is the only
    // path a dictated phrase has to the PTY.
    terminal.options.screenReaderMode = true;
    textarea.value = 'abc';
    fireInput('insertText');
    expect(sent).toEqual(['abc']);
  });

  it('leaves a keydown-sent insertion to xterm in screen-reader mode', () => {
    // xterm sends the key from keydown without cancelling it, so the browser
    // then inserts it into the field — no keypress involved.
    terminal.options.screenReaderMode = true;
    fireKey('keydown', 65);
    textarea.value = 'a';
    fireInput('insertText');
    fireKey('keyup', 65);
    fireKey('keydown', 8);
    textarea.value = '';
    fireInput('deleteContentBackward');
    fireKey('keyup', 8);
    expect(sent).toEqual([]);
  });

  it('does not claim text the sink reports as dropped', () => {
    dispose();
    let delivered = false;
    dispose = attachDictationBridge(terminal, (d) => { if (delivered) sent.push(d); return delivered; });
    // Mid session-switch: the emit is refused, so the PTY never saw 'abc'.
    textarea.value = 'abc';
    fireInput('insertText');
    delivered = true;
    // Once sends land again the whole phrase goes out — no DELs for characters
    // that never arrived, and no silently swallowed words.
    textarea.value = 'abd';
    fireInput('insertReplacementText');
    expect(sent).toEqual(['abd']);
  });

  it('resyncs after a keystroke xterm handles itself', () => {
    textarea.value = 'abc';
    fireInput('insertText');
    // Enter: xterm sends CR and clears the textarea.
    fireKey('keydown', 13);
    textarea.value = '';
    vi.runAllTimers();
    // Next dictation starts from a clean mirror — no phantom DELs for 'abc'.
    textarea.value = 'next';
    fireInput('insertText');
    expect(sent).toEqual(['abc', 'next']);
  });

  it('leaves an insertion the keypress path already sent to xterm', () => {
    // Capitals and space are the keys xterm forwards from `keypress` without
    // cancelling it, so the character lands in the textarea and fires `input`
    // AFTER the PTY already has it. Diffing that insertion doubled every one.
    fireKey('keydown');
    fireKey('keypress');
    textarea.value = 'T';
    fireInput('insertText');
    expect(sent).toEqual([]);
    // It counts as floor, not as ours: dictating on top appends instead of
    // erasing the capital xterm sent.
    textarea.value = 'There';
    fireInput('insertText');
    expect(sent).toEqual(['here']);
  });

  it('does not let a keypress that inserted nothing disown the next phrase', () => {
    // The insertion a keypress produces can fail to arrive. Dictation then follows
    // with no key events at all, so only keyup can clear the latch in time —
    // waiting for the next keydown would swallow the phrase into the floor.
    fireKey('keypress');
    fireKey('keyup');
    textarea.value = 'ab';
    fireInput('insertText');
    expect(sent).toEqual(['ab']);
  });

  it('disarms the latch when focus leaves mid-keystroke', () => {
    // Blur can land between the keypress and the keyup that would have cleared it.
    fireKey('keypress');
    textarea.dispatchEvent(new FocusEvent('blur'));
    vi.runAllTimers();
    textarea.value = 'ab';
    fireInput('insertText');
    expect(sent).toEqual(['ab']);
  });

  it('does not resync on the composition keycode soft keyboards report', () => {
    fireKey('keydown', 229);
    textarea.value = 'ab';
    fireInput('insertText');
    vi.runAllTimers();
    textarea.value = 'abc';
    fireInput('insertText');
    expect(sent).toEqual(['ab', 'c']);
  });

  it('resyncs on blur, which clears xterm\'s textarea', () => {
    textarea.value = 'abc';
    fireInput('insertText');
    textarea.dispatchEvent(new FocusEvent('blur'));
    textarea.value = '';
    vi.runAllTimers();
    textarea.value = 'fresh';
    fireInput('insertText');
    expect(sent).toEqual(['abc', 'fresh']);
  });

  it('cancels a pending resync when it reconciles the field itself', () => {
    // A keystroke xterm handled arms a resync; the dictation event that follows
    // reconciles the field first. If the stale timer still fired it would pin the
    // floor to the whole phrase and silently swallow every later correction.
    textarea.value = 'their';
    fireInput('insertText');
    // Field is non-empty now, so this keystroke really does arm a resync.
    fireKey('keydown', 32);
    textarea.value = 'there';
    fireInput('insertReplacementText');
    vi.runAllTimers();
    // A stale resync would have pinned floor to 'there'.length, and this
    // correction would emit nothing at all.
    textarea.value = 'their';
    fireInput('insertReplacementText');
    expect(sent).toEqual(['their', `${DEL}${DEL}re`, `${DEL}${DEL}ir`]);
  });

  it('arms no timer while typing leaves nothing to reconcile', () => {
    const timer = vi.spyOn(globalThis, 'setTimeout');
    fireKey('keydown', 65);
    expect(timer).not.toHaveBeenCalled();
    timer.mockRestore();
  });

  it('detaches every listener on dispose', () => {
    dispose();
    const xterm = attachXtermStub();
    textarea.value = 'after';
    fireInput('insertText');
    expect(sent).toEqual([]);
    expect(xterm).toHaveBeenCalledTimes(1);
  });
});

// The bridge's whole seam is "our capture-phase listener on terminal.element runs
// before xterm's own listener on the textarea inside it". The stub above can't
// prove that — only a real Terminal can, and this is what fails loudly if an
// xterm upgrade moves or re-phases that listener.
describe('attachDictationBridge against a real xterm Terminal', () => {
  let container;
  let terminal;

  beforeEach(() => {
    // xterm reads the device pixel ratio on open(); jsdom ships no matchMedia.
    window.matchMedia = vi.fn(() => ({ matches: false, addListener() {}, removeListener() {} }));
    container = document.createElement('div');
    document.body.appendChild(container);
    terminal = new Terminal({ allowProposedApi: true });
    terminal.open(container);
  });

  afterEach(() => {
    terminal.dispose();
    container.remove();
    delete window.matchMedia;
  });

  // Each refinement replaces the field's whole contents, which is what Apple
  // dictation does — `data` carries the text the field gained, exactly the value
  // xterm's own handler forwards verbatim.
  const dictate = (partials) => {
    for (const partial of partials) {
      terminal.textarea.value = partial;
      terminal.textarea.dispatchEvent(new InputEvent('input', {
        inputType: 'insertText', data: partial, bubbles: true,
      }));
    }
  };

  // The bug, pinned upstream. If a future @xterm/xterm starts reconciling these
  // events itself this fails — at which point the bridge is double-handling and
  // should go, rather than quietly fighting xterm for the same input.
  it('garbles the phrase when xterm handles the events alone', () => {
    const sent = [];
    terminal.onData((d) => sent.push(d));
    dictate(['dde', 'deter', 'determin', 'determine', 'determines']);
    expect(sent.join('')).toBe('ddedeterdetermindeterminedetermines');
  });

  // A keystroke xterm defers to keypress, exactly as Chrome delivers it: xterm
  // ignores the keydown, forwards the character from keypress WITHOUT cancelling
  // it, and the browser then inserts it into the textarea and fires `input`. Two
  // senders, one character.
  const typeThroughKeypress = (ch) => {
    const code = ch.charCodeAt(0);
    const { textarea } = terminal;
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: ch, keyCode: code, bubbles: true }));
    textarea.dispatchEvent(new KeyboardEvent('keypress', { key: ch, keyCode: code, charCode: code, bubbles: true }));
    textarea.value += ch;
    textarea.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: ch, bubbles: true }));
    textarea.dispatchEvent(new KeyboardEvent('keyup', { key: ch, keyCode: code, bubbles: true }));
  };

  it('does not double a character xterm sent from keypress', () => {
    const sent = [];
    terminal.onData((d) => sent.push(d));
    // Capitals land here through xterm's A-Z hack, space because its keyCode falls
    // below the printable range xterm's keyboard map claims — two mechanisms, and
    // the changelog claims both. Proves xterm really is the sender on this path: if
    // an upgrade moves either to keydown-with-cancel, this fails and the bridge's
    // keypress seam can go.
    typeThroughKeypress('T');
    typeThroughKeypress(' ');
    expect(sent).toEqual(['T', ' ']);

    const dispose = attachDictationBridge(terminal, (d) => { sent.push(d); });
    typeThroughKeypress('X');
    typeThroughKeypress(' ');
    dispose();
    expect(sent).toEqual(['T', ' ', 'X', ' ']);
  });

  // The Shell page runs xterm in screen-reader mode (createShellTerminal), where
  // xterm drops every insertText event: dictation, which fires no key events,
  // never reached the PTY at all. If an upgrade starts forwarding these, the
  // first assertion fails and the bridge would double-send in this mode.
  it('delivers dictation in screen-reader mode, where xterm alone drops it', () => {
    terminal.options.screenReaderMode = true;
    const sent = [];
    terminal.onData((d) => sent.push(d));
    dictate(['hello']);
    expect(sent).toEqual([]);

    terminal.textarea.value = '';
    const dispose = attachDictationBridge(terminal, (d) => { sent.push(d); });
    dictate(['dde', 'deter', 'determines']);
    // A lowercase key xterm sends from keydown without cancelling it: the browser
    // then inserts it into the field, and it must not go out twice.
    const { textarea } = terminal;
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', keyCode: 88, bubbles: true }));
    textarea.value += 'x';
    textarea.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: 'x', bubbles: true }));
    textarea.dispatchEvent(new KeyboardEvent('keyup', { key: 'x', keyCode: 88, bubbles: true }));
    dispose();

    expect(render(sent)).toBe('determinesx');
  });

  it('sends the dictated phrase once, not the accumulated garble', () => {
    const sent = [];
    // onData is where xterm's own textarea handling would surface, so anything it
    // forwards behind our back shows up here too.
    terminal.onData((d) => sent.push(d));
    const dispose = attachDictationBridge(terminal, (d) => { sent.push(d); });
    dictate(['dde', 'deter', 'determin', 'determine', 'determines']);
    dispose();

    expect(render(sent)).toBe('determines');
  });
});
