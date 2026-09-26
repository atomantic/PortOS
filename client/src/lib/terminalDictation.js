// Dictation/IME bridge for the xterm.js terminal.
//
// ── The bug this fixes ─────────────────────────────────────────────────────────
// Apple dictation (iOS "mic" key, macOS Fn Fn) does not emit one final phrase —
// it streams progressively refined guesses and REPLACES what it previously wrote
// in the focused field. In a normal <textarea> that is invisible: the field's
// value goes "dde" → "deter" → "determin" → "determines", each edit replacing the
// last. xterm.js, though, is a character STREAM: its hidden textarea listener
// (`CoreBrowserTerminal#_inputEvent`) forwards `inputType: 'insertText'` events
// verbatim and ignores every deletion event, because a terminal has no notion of
// "replace what I just sent". So each refinement is appended to the PTY and the
// user gets the accumulated garble:
//
//   ddedeterdetermindeterminedetermines ifdetermines if any code…
//
// ── The fix ────────────────────────────────────────────────────────────────────
// Intercept textarea input events in the capture phase (on `terminal.element`, so
// we run BEFORE xterm's own listener on the textarea inside it) and forward a
// DIFF instead of the raw insertion: DEL (0x7f) for each character the field
// dropped, then whatever it gained. The textarea keeps accumulating exactly as the
// OS intends, and the PTY sees the same edits a real text field would apply.
//
// Resync points (a keystroke xterm handles itself, blur, paste, composition end)
// reset the mirror without emitting anything, because those paths send to the PTY
// through xterm and may clear the textarea out from under us.
//
// ── The keypress seam ──────────────────────────────────────────────────────────
// Mirrored from @xterm/xterm 6.0.0 — `CoreBrowserTerminal#_keyPress` and
// `#_inputEvent`. Re-read those two before trusting this section against a newer
// xterm; the real-Terminal tests fail loudly if either mechanism moves.
// Not every physical keystroke is settled on `keydown`. xterm cancels that event
// for most printable keys (so the character never reaches the textarea and no
// input event fires), but it deliberately defers A-Z and keys its keyboard map
// doesn't claim — space among them — to the `keypress` handler, which forwards the
// character and then does NOT preventDefault. The browser therefore inserts it
// into the textarea and fires `input` for a character the PTY already has, and
// xterm's own `_inputEvent` drops that event via its `_keyPressHandled` guard.
// Stopping the event before xterm took that guard's say away, and diffing the
// insertion sent the character a second time — the reported "every capital letter
// and space is doubled". So an insertion with a live keypress behind it is now
// xterm's: it counts as a resync point, not ours to forward, and the event goes
// through untouched.
//
// Screen-reader mode widens the seam to keydown. There xterm sends a resolved key
// from `_keyDown` and deliberately does NOT cancel it (so the textarea keeps the
// text for the screen reader to announce) — lowercase letters, digits, Backspace
// all land in the field and fire `input` for bytes the PTY already has. So in that
// mode a live keydown latches the same way a keypress does. Outside it, a handled
// keydown is cancelled and never reaches the field.
//
// We mirror `_keyPressHandled` and only that flag. xterm's `_inputEvent` also gates
// on `_keyDownSeen` and clears an `_unprocessedDeadKey`; the omissions are
// deliberate, because our own resync points already cover both — the keydown resync
// for the first, the `compositionend` resync for the second.
//
// ── Boundaries ─────────────────────────────────────────────────────────────────
// Corrections are streamed live, which assumes the far end treats 0x7f as "erase
// the previous character" — true at a shell prompt and in the line editors of the
// TUIs this page drives. In a full-screen app that binds DEL to something else, a
// mid-phrase correction is as approximate as a human backspacing would be; live
// echo is worth more here than a settle-then-send buffer that hides the words the
// user is speaking. Because we stop the event before xterm sees it, xterm never
// clears the textarea mid-phrase either, so the mirror grows for as long as the
// dictation does (bounded by the next resync — Enter, Ctrl-C, or blur).

// 0x7f — what a terminal expects for "erase the previous character".
export const TERMINAL_DEL = '\x7f';

// Input events whose effect we translate into terminal input ourselves: text the
// field gained, and every flavour of text it dropped. Anything else (paste, undo,
// composition text, line breaks) is already handled by xterm or the keydown path
// and only resyncs our mirror — an unknown future `insert*` type must fall through
// to xterm rather than being double-sent by both of us.
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
  // Never split a surrogate pair: cutting between the halves of an astral
  // character (swapping 😀 for 😂 shares the high surrogate) would send a lone
  // surrogate, which serializes to U+FFFD instead of the emoji.
  return i > 0 && isHighSurrogate(a.charCodeAt(i - 1)) ? i - 1 : i;
};

/**
 * Plan the terminal input for a text-field edit.
 *
 * @param {string} mirror   what the PTY holds from this field
 * @param {string} next     what the field holds now
 * @param {number} floor    how much of `mirror` reached the PTY some other way
 *   (typed keystrokes, a paste). We retype from the floor rather than rewinding
 *   through it, so a correction can never erase text we didn't write.
 * @returns {{data: string, committed: string}} `data` is the bytes to send ('' when
 *   nothing changed); `committed` is what the PTY holds once they're applied. The
 *   two differ from `next` only when `floor` blocked a full rewind — the caller
 *   must track `committed`, not `next`, or every later diff is computed against a
 *   baseline the PTY never had.
 */
export const planFieldEdit = (mirror, next, floor = 0) => {
  const rewindTo = Math.min(mirror.length, Math.max(commonPrefixLength(mirror, next), floor));
  const tail = next.slice(rewindTo);
  // One DEL erases one CODE POINT at the far end, but JS string length counts
  // UTF-16 code units — so an emoji is one erase, not two. Counting units would
  // send a second DEL that eats the character before it.
  const erased = [...mirror.slice(rewindTo)].length;
  return {
    // Pure append is the common case — skip building an empty DEL run for it.
    data: rewindTo === mirror.length ? tail : TERMINAL_DEL.repeat(erased) + tail,
    committed: mirror.slice(0, rewindTo) + tail,
  };
};

/**
 * Wire the dictation bridge onto a live xterm instance.
 *
 * @param {object} terminal — an xterm `Terminal`. Only its public surface is used:
 *   `element` (the container it mounted into, and an ancestor of `textarea`, so
 *   capture-phase listeners there run before xterm's own), `textarea`, `options`.
 * @param {(data: string) => boolean|void} sendData — forwards to the PTY. Return
 *   `false` to report the data was dropped (e.g. mid session-switch); the mirror
 *   then treats it as text we didn't write instead of claiming the PTY has it.
 * @returns {() => void} dispose
 */
export const attachDictationBridge = (terminal, sendData) => {
  const container = terminal?.element;
  const textarea = terminal?.textarea;
  if (!container || !textarea || typeof sendData !== 'function') return () => {};

  // What the PTY holds from this field. Usually equal to the textarea's value —
  // it diverges only when `floor` blocked a full rewind (see planFieldEdit).
  let mirror = textarea.value;
  // Length of `mirror` we did not put into the PTY ourselves — see planFieldEdit.
  let floor = mirror.length;
  let resyncTimer = null;
  // Set on `keypress` (and, in screen-reader mode, on keydown), consumed by the next
  // event — see "The keypress seam" above.
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

  // Deferred: xterm's own handler runs after ours and may clear the textarea
  // (Enter and Ctrl-C do), so read the field only once it has had its turn.
  const scheduleResync = () => {
    // Physical typing is the hot path and leaves nothing to reconcile — xterm
    // cancels those keydowns, so the textarea stays as empty as the mirror.
    if (resyncTimer != null || (mirror === '' && textarea.value === '')) return;
    resyncTimer = setTimeout(resyncNow, 0);
  };

  const handleKeyDown = (ev) => {
    // Whatever this keystroke inserts is xterm's only if a keypress follows it —
    // or, in screen-reader mode, already, because xterm sent it from keydown.
    keyStrokeSeen = false;
    // 229 is the "composition character" every soft keyboard/IME reports — those
    // keystrokes land in the textarea and are ours to diff, not a resync point.
    // They fire no keypress either, which is what keeps them ours below.
    if (ev.keyCode === 229 || ev.isComposing) return;
    if (terminal.options?.screenReaderMode) keyStrokeSeen = true;
    scheduleResync();
  };

  const handleKeyPress = () => { keyStrokeSeen = true; };

  // The insertion a keypress produces can fail to arrive (the browser consumes the
  // combination itself, focus leaves mid-keystroke). Disarm on keyup — as xterm's
  // own `_keyUp` disarms `_keyPressHandled` — so the latch can't outlive the
  // keystroke and disown the next insertion. Dictation supplies no key events at
  // all, so waiting for another keydown to clear it would swallow a dictated phrase.
  // `input` fires during the keypress default action, long before keyup, so this
  // never races the consume.
  const disarmKeyStroke = () => { keyStrokeSeen = false; };

  const handleBlur = () => {
    disarmKeyStroke();
    scheduleResync();
  };

  const handleInput = (ev) => {
    if (ev.target !== textarea) return;
    // The character reached the PTY through xterm's keypress path already (see "The
    // keypress seam"). Take the insertion into the floor so a later correction can't
    // rewind through it, and leave the event alone. Consumed ahead of the guards
    // below so the latch is strictly one-shot.
    if (keyStrokeSeen) {
      disarmKeyStroke();
      resyncNow();
      return;
    }
    // A real composition (IME candidate window) is xterm's CompositionHelper's job;
    // it forwards the committed text on compositionend.
    if (ev.isComposing) return;
    if (!isOwnedInput(ev.inputType)) {
      resyncNow();
      return;
    }
    // Ours: stop the event before xterm's textarea listener can append the raw
    // insertion on top of what we're about to reconcile.
    ev.stopPropagation();
    // We are reconciling the field right now, so a resync armed by the keystroke
    // that produced this event would only re-read the same value — and pin `floor`
    // to the whole phrase, silently blocking every later correction from rewinding.
    cancelResync();
    const { data, committed } = planFieldEdit(mirror, textarea.value, floor);
    // A refused send leaves the PTY exactly as it was, so leave the mirror there
    // too — the next refinement then re-diffs against what the PTY really has
    // instead of erasing characters that never arrived.
    if (data && sendData(data) === false) return;
    // `committed`, not the field's value: when `floor` blocked a full rewind the
    // PTY holds the un-rewound prefix, and claiming otherwise desyncs every
    // later diff.
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
