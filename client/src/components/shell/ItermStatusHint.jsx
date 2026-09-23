// One compact line naming the fix for an iTerm2 view that isn't showing
// sessions (#8114). `state` is the bridge status (see docs/ITERM.md).
export const ITERM_STATUS_HINTS = {
  'unsupported-platform': 'iTerm2 sessions are only available on macOS.',
  'not-installed': 'iTerm2 isn’t installed in /Applications or ~/Applications.',
  'api-disabled': 'Enable iTerm2 Settings → General → Magic → Enable Python API.',
  'not-running': 'iTerm2 isn’t running.',
  'auth-failed': 'Allow PortOS to control iTerm2 in System Settings → Privacy & Security → Automation.',
  'connect-failed': 'Couldn’t connect to iTerm2’s API — check that the Python API is enabled.',
  disconnected: 'Connecting to iTerm2…',
};

export const itermHintText = ({ state, sessionCount }) => {
  if (state === 'connected') return sessionCount === 0 ? 'No iTerm2 sessions open.' : null;
  return ITERM_STATUS_HINTS[state] ?? null;
};

export default function ItermStatusHint({ state, sessionCount }) {
  const text = itermHintText({ state, sessionCount });
  if (!text) return null;
  return (
    <p role="status" className="shrink-0 px-1 text-xs text-port-warning">
      {text}
    </p>
  );
}
