import InlineConfirmRow from './InlineConfirmRow';

// The discard confirm every `useUnsavedChangesGuard` consumer renders from
// `blocked` (#3958/#3995) — one styling contract instead of a copy per editor.
// Pass the guard straight through; it renders nothing unless a navigation is
// actually parked.
//
//   <UnsavedChangesConfirm
//     guard={routeGuard}
//     when={!saving}
//     question="Discard your unsaved changes to this song?"
//     label={`Discard unsaved changes to ${song.title}`}
//     onDiscard={discardAndExit}
//   />
//
// A page that ALSO defers a non-router exit of its own (SongBookViewer parks
// its View toggle, which only flips a search param) needs its own `blocked ||
// pendingExit` condition and its own cancel handler, so it drives
// `InlineConfirmRow` directly rather than going through here.
//
// `when` (default true) is the caller's extra render gate — pass `!saving` when
// a save is in flight. The navigation stays PARKED either way; suppressing the
// row just avoids flashing a confirm for a draft that is about to settle clean
// and auto-proceed on its own. Discarding is the caller's job (only it knows
// how to reset its draft), so `onDiscard` resets state and then calls
// `guard.proceed()`.
export default function UnsavedChangesConfirm({
  guard,
  question,
  label,
  onDiscard,
  when = true,
  confirmText = 'Discard',
  cancelText = 'Keep editing',
}) {
  if (!guard.blocked || !when) return null;
  return (
    <InlineConfirmRow
      className="shrink-0"
      variant="separator"
      tone="warning"
      question={question}
      confirmText={confirmText}
      cancelText={cancelText}
      onConfirm={onDiscard}
      onCancel={guard.reset}
      autoFocus
      aria-label={label}
    />
  );
}
