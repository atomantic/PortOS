// The saved / dirty / pending-switch / detail-read state every Prompt Manager
// editor repeats: one URL-selected record, an editable value, the last value
// the server confirmed, and the record the user asked for while holding
// unsaved edits.
import { useEffect, useRef, useState } from 'react';

const IDLE_READ = { identity: null, status: 'idle', error: '' };

/**
 * @param {object} opts
 * @param {string|null} opts.selected  The URL-selected record id.
 * @param {*} opts.blank               Value of an empty editor; must be a stable reference.
 * @param {(a, b) => boolean} [opts.isEqual]  Compares the edited value with the saved baseline.
 * @param {(id) => Promise} [opts.load] Detail read for `selected`. Without it the editor is always
 *   writable (Variables hydrates from its catalogue instead).
 * @param {(res) => *} [opts.hydrate]  Maps a successful read to the editor value.
 * @param {() => void} [opts.onReset]  Clears editor-specific state (preview, metadata) whenever a new
 *   read starts.
 * @param {string} [opts.noun]         Names the record in read errors.
 * @param {(id) => void} opts.onSwitch Replaces the open record; called when nothing would be lost.
 * @param {(id) => boolean} [opts.isCurrent]  Whether `id` is the record already open.
 * @param {() => void} [opts.onReselect]  Runs when the open record is requested again.
 * @param {() => void} [opts.onPark]   Runs when a request parks behind the discard question.
 */
export default function useRecordEditor({
  selected, blank, isEqual = Object.is, load, hydrate, onReset, noun = 'record',
  onSwitch, isCurrent, onReselect, onPark,
}) {
  const [value, setValue] = useState(blank);
  // The last value the server confirmed (loaded or saved). Kept as a full copy
  // rather than a boolean flag so typing an edit and undoing it back to the
  // original stops counting as dirty — a stale flag would nag on a no-op edit.
  const [saved, setSaved] = useState(blank);
  // `{ key }` the user asked to open while holding unsaved edits, awaiting
  // confirmation. An object rather than a bare key so a null key (Variables'
  // blank "+" form) is a real pending value instead of "nothing pending".
  const [pending, setPending] = useState(null);
  const [read, setRead] = useState(IDLE_READ);
  const [readAttempt, setReadAttempt] = useState(0);
  // Compared during render, before the URL-keyed effect runs: Back/Forward
  // must revoke the outgoing editor's admission immediately.
  const ready = load
    ? Boolean(selected) && read.identity === selected && read.status === 'ready'
    : true;
  const dirty = ready && !isEqual(value, saved);

  // Saves and previews resume after an await holding the values their closure
  // captured at click time, so they read the live selection/value through this
  // ref to tell "still the same editor" from "the user moved on mid-flight".
  const liveRef = useRef({ selected, value });
  liveRef.current = { selected, value };
  const optsRef = useRef(null);
  optsRef.current = { blank, load, hydrate, onReset, noun };

  // A clean editor has nothing to discard, so an armed row disarms itself the
  // moment the edit is undone or saved — leaving the id parked would re-arm
  // that row out of nowhere the next time the user typed.
  useEffect(() => {
    if (!dirty) setPending(null);
  }, [dirty]);

  // Fetch the URL-selected record. Keyed on `selected` so a deep link / reload
  // restores the open editor and a cleared param resets it. Everything is
  // cleared up front rather than on the way out, so an in-flight read (or one
  // that fails on a stale deep link) can never leave the PREVIOUS record's
  // value rendered under the newly selected record's heading.
  useEffect(() => {
    const opts = optsRef.current;
    if (!opts.load) return undefined;
    opts.onReset?.();
    setValue(opts.blank);
    setSaved(opts.blank);
    setPending(null);
    setRead({ identity: selected, status: selected ? 'loading' : 'idle', error: '' });
    if (!selected) return undefined;
    let active = true;
    opts.load(selected)
      .then((res) => {
        if (!active) return;
        if (!res) throw new Error(`No ${opts.noun} details returned`);
        const next = opts.hydrate(res);
        // Baselined in the same tick as the editor value, so the dirty check
        // can never see one without the other.
        setValue(next);
        setSaved(next);
        setRead({ identity: selected, status: 'ready', error: '' });
      })
      .catch((err) => {
        if (active) setRead({ identity: selected, status: 'error', error: err.message || `Unable to load ${opts.noun} details` });
      });
    return () => { active = false; };
  }, [selected, readAttempt]);

  // Replaces the editor with a record or the blank form. Cleared in the same
  // tick as the caller's selection change, not left to the URL-keyed effect —
  // otherwise the frame between the two renders the OUTGOING record's value
  // and dirty badges under the incoming record's row.
  const reset = (next = blank) => {
    setPending(null);
    setValue(next);
    setSaved(next);
  };

  // Switching records replaces the editor, so unsaved edits must be confirmed
  // away first: the requested record parks in `pending` and an inline confirm
  // row takes over its list slot — no window.confirm.
  const request = (key) => {
    if (isCurrent ? isCurrent(key) : key === selected) {
      // Re-clicking the open record is how a user backs out of the question
      // from the list side; leaving it armed would strand the row mid-question.
      setPending(null);
      onReselect?.();
      return;
    }
    if (dirty) {
      onPark?.();
      setPending({ key });
      return;
    }
    onSwitch(key);
  };

  // Re-baselines on a successful save only while the same record is still
  // open: a save that lands after the user moved on would otherwise stamp the
  // outgoing record's value as the incoming one's saved state. Edits typed
  // while the request was open stay dirty — the server never saw them.
  const markSaved = (sentFor, sentValue) => {
    const live = liveRef.current;
    if (sentFor !== live.selected) return false;
    setSaved(sentValue);
    if (isEqual(sentValue, live.value)) setPending(null);
    return true;
  };

  return {
    value,
    setValue,
    setSaved,
    dirty,
    ready,
    read,
    readFailed: read.identity === selected && read.status === 'error',
    retryRead: () => setReadAttempt((attempt) => attempt + 1),
    // The dirty check is part of the render condition, not just of arming:
    // undoing the edit while the row is armed leaves nothing to discard.
    isPending: (key) => pending !== null && pending.key === key && dirty,
    cancelPending: () => setPending(null),
    request,
    reset,
    markSaved,
    liveRef,
  };
}
