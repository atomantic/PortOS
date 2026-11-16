// Dictation/IME bridge for the xterm.js terminal.
//
// Apple dictation streams progressively refined guesses and REPLACES what it
// previously wrote in the focused field ("dde" → "deter" → "determines"). xterm.js
// is a character STREAM: its textarea listener (`CoreBrowserTerminal#_inputEvent`)
// forwards `insertText` verbatim and ignores deletions, so each refinement is
// appended to the PTY as accumulated garble.
//
// We intercept textarea input events in the capture phase (on `terminal.element`,
// BEFORE xterm's listener) and forward a DIFF: DEL (0x7f) per character the field
// dropped, then whatever it gained. Resync points (a keystroke xterm handles
// itself, blur, paste, composition end) reset the mirror without emitting, because
// those paths send through xterm and may clear the textarea under us.
//
// The keypress seam: mirrored from @xterm/xterm 6.0.0 (`_keyPress`, `_inputEvent`);
// re-read both before trusting this against a newer xterm (the real-Terminal tests
// fail loudly if either moves). xterm cancels `keydown` for most printable keys,
// but defers A-Z and unmapped keys (space) to `keypress`, which forwards the
// character WITHOUT preventDefault, so the browser also fires `input` for a
// character the PTY already has; xterm drops that via `_keyPressHandled`. Stopping
// the event first removed that guard and doubled capitals and spaces, so an
// insertion with a live keypress behind it is xterm's: a resync point, event
// untouched. Screen-reader mode widens the seam to keydown (xterm sends from
// `_keyDown` without cancelling), so a live keydown latches the same way there.
// We mirror only `_keyPressHandled`; `_keyDownSeen` and `_unprocessedDeadKey` are
// covered by our keydown and `compositionend` resyncs.
//
// Boundary: corrections stream live, assuming the far end treats 0x7f as "erase
// the previous character" (true at a shell prompt and in TUI line editors); live
// echo beats a settle-then-send buffer that hides the spoken words. Because xterm
// never sees the event, it never clears the textarea mid-phrase, so the mirror
// grows until the next resync (Enter, Ctrl-C, or blur).

// 0x7f — what a terminal expects for "erase the previous character".
export const TERMINAL_DEL = '\x7f';

// Input events we translate into terminal input ourselves: text the field gained
// and every flavour it dropped. Anything else (paste, undo, composition text, line
// breaks) is handled by xterm or the keydown path and only resyncs the mirror; an
// unknown future `insert*` type must fall through to xterm, not be double-sent.
const isOwnedInput = (inputType) => (
  !inputType
  || inputType === 'insertText'
  || inputType === 'insertReplacementText'
  || inputType.startsWith('delete')
);

const isHighSurrogate = (code) => code >= 0xd800 && code <= 0xdbff;

const commonPrefixLength = (a, b) => {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  // Never split a surrogate pair: a lone surrogate serializes to U+FFFD.
  return i > 0 && isHighSurrogate(a.charCodeAt(i - 1)) ? i - 1 : i;
};

/**
 * Plan the terminal input for a text-field edit.
 *
 * @param {string} mirror   what the PTY holds from this field
 * @param {string} next     what the field holds now
 * @param {number} floor    how much of `mirror` reached the PTY some other way
 *   (keystrokes, a paste); we retype from it rather than rewinding through it, so
 *   a correction never erases text we didn't write.
 * @returns {{data: string, committed: string}} `data` is the bytes to send ('' when
 *   unchanged); `committed` is what the PTY holds once applied, which differs from
 *   `next` when `floor` blocked a full rewind. Callers track `committed`.
 */
export const planFieldEdit = (mirror, next, floor = 0) => {
  const rewindTo = Math.min(mirror.length, Math.max(commonPrefixLength(mirror, next), floor));
  const tail = next.slice(rewindTo);
  // One DEL erases one CODE POINT at the far end, but JS length counts UTF-16
  // units, so count code points or an emoji sends a second, over-eager DEL.
  const erased = [...mirror.slice(rewindTo)].length;
  return {
    // Pure append is the common case — skip building an empty DEL run for it.
    data: rewindTo === mirror.length ? tail : TERMINAL_DEL.repeat(erased) + tail,
    committed: mirror.slice(0, rewindTo) + tail,
  };
};

/**
 * Wire the dictation bridge onto a live xterm instance. Uses only `terminal.element`
 * (an ancestor of `textarea`, so capture listeners there run first), `textarea`
 * and `options`. `sendData` forwards to the PTY; return `false` when the data was
 * dropped (e.g. mid session-switch) so the mirror treats it as unwritten.
 * @returns {() => void} dispose
 */
export const attachDictationBridge = (terminal, sendData) => {
  const container = terminal?.element;
  const textarea = terminal?.textarea;
  if (!container || !textarea || typeof sendData !== 'function') return () => {};

  // What the PTY holds from this field; diverges from the textarea value only
  // when `floor` blocked a full rewind.
  let mirror = textarea.value;
  // Length of `mirror` we did not put into the PTY ourselves — see planFieldEdit.
  let floor = mirror.length;
  let resyncTimer = null;
  // Set on `keypress` (and, in screen-reader mode, keydown); see "The keypress seam".
  let keyStrokeSeen = false;

  const cancelResync = () => {
    clearTimeout(resyncTimer);
    resyncTimer = null;
  };

  const resyncNow = () => {
    cancelResync();
    mirror = textarea.value;
    floor = mirror.length;
  };

  // Deferred: xterm's handler runs after ours and may clear the textarea (Enter,
  // Ctrl-C), so read the field only after its turn.
  const scheduleResync = () => {
    // Physical typing is the hot path: xterm cancels those keydowns, so there is
    // nothing to reconcile.
    if (resyncTimer != null || (mirror === '' && textarea.value === '')) return;
    resyncTimer = setTimeout(resyncNow, 0);
  };

  const handleKeyDown = (ev) => {
    // This keystroke's insertion is xterm's only if a keypress follows (or, in
    // screen-reader mode, already, since xterm sent it from keydown).
    keyStrokeSeen = false;
    // 229 is the "composition character" every soft keyboard/IME reports; those
    // land in the textarea and are ours to diff. They fire no keypress.
    if (ev.keyCode === 229 || ev.isComposing) return;
    if (terminal.options?.screenReaderMode) keyStrokeSeen = true;
    scheduleResync();
  };

  const handleKeyPress = () => { keyStrokeSeen = true; };

  // The keypress's insertion can fail to arrive (browser consumes the combination,
  // focus leaves). Disarm on keyup, as xterm's `_keyUp` does, so the latch can't
  // disown the next insertion; dictation supplies no key events, so waiting for
  // another keydown would swallow a dictated phrase. `input` fires during the
  // keypress default action, long before keyup.
  const disarmKeyStroke = () => { keyStrokeSeen = false; };

  const handleBlur = () => {
    disarmKeyStroke();
    scheduleResync();
  };

  const handleInput = (ev) => {
    if (ev.target !== textarea) return;
    // Reached the PTY via xterm's keypress path already. Fold it into the floor so
    // a correction can't rewind through it, and leave the event alone. Consumed
    // before the guards so the latch is strictly one-shot.
    if (keyStrokeSeen) {
      disarmKeyStroke();
      resyncNow();
      return;
    }
    // A real IME composition is xterm's CompositionHelper's job (committed on compositionend).
    if (ev.isComposing) return;
    if (!isOwnedInput(ev.inputType)) {
      resyncNow();
      return;
    }
    // Ours: stop the event before xterm appends the raw insertion on top.
    ev.stopPropagation();
    // A resync armed by this keystroke would re-read the same value and pin `floor`
    // to the whole phrase, blocking later corrections from rewinding.
    cancelResync();
    const { data, committed } = planFieldEdit(mirror, textarea.value, floor);
    // A refused send leaves the PTY as it was; keep the mirror there so the next
    // diff doesn't erase characters that never arrived.
    if (data && sendData(data) === false) return;
    // `committed`, not the field's value: `floor` may have blocked a full rewind.
    mirror = committed;
  };

  // blur/compositionend don't bubble, but capture-phase listeners still see them.
  const listeners = [
    ['keydown', handleKeyDown],
    ['keypress', handleKeyPress],
    ['keyup', disarmKeyStroke],
    ['input', handleInput],
    ['blur', handleBlur],
    ['compositionend', scheduleResync],
  ];
  for (const [type, handler] of listeners) container.addEventListener(type, handler, true);

  return () => {
    cancelResync();
    for (const [type, handler] of listeners) container.removeEventListener(type, handler, true);
  };
};
