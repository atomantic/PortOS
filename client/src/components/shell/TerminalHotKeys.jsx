import { OctagonX, ClipboardPaste, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, CornerDownLeft } from 'lucide-react';

// Hot buttons for arrow / Enter entry — handy on touch devices and for driving TUI
// apps or scrolling shell history without a hardware keyboard. Arrow keys carry the
// final char only: the CSI (`\x1b[`) vs SS3 (`\x1bO`) prefix is chosen at send time
// from the terminal's application-cursor-key mode (DECCKM) so the button matches what
// a real arrow keypress emits — many full-screen TUIs (vim, htop) set DECCKM and expect
// the SS3 form. Enter is a literal carriage return, unaffected by cursor mode.
export const NAV_KEYS = [
  { label: 'Up', Icon: ArrowUp, code: 'A' },
  { label: 'Down', Icon: ArrowDown, code: 'B' },
  { label: 'Left', Icon: ArrowLeft, code: 'D' },
  { label: 'Right', Icon: ArrowRight, code: 'C' },
  { label: 'Enter', Icon: CornerDownLeft, seq: '\r' },
];

// Touch-friendly TUI-driving controls shared by the inline quick-commands toolbar
// and the fullscreen control bar: Ctrl+C, Paste (+ fallback paste input), and the
// arrow / Enter hot buttons. The Ctrl+C / Paste text labels collapse below `sm` so
// the cluster stays narrow on a phone; the icons always show.
export default function TerminalHotKeys({ sendCtrlC, handlePaste, sendNavKey, showPasteInput, setShowPasteInput, pasteInputRef, handlePasteInputEvent }) {
  return (
    <>
      <button
        onClick={sendCtrlC}
        className="flex items-center gap-1.5 px-3 py-1.5 bg-port-error/15 hover:bg-port-error/25 text-port-error hover:text-port-error/80 rounded text-xs font-mono transition-colors border border-port-error/30 min-h-[40px] shrink-0"
        title="Send Ctrl+C interrupt"
        aria-label="Send Ctrl+C interrupt"
      >
        <OctagonX size={14} />
        <span className="hidden sm:inline">Ctrl+C</span>
      </button>
      <button
        onClick={handlePaste}
        className="flex items-center gap-1.5 px-3 py-1.5 bg-port-accent/15 hover:bg-port-accent/25 text-port-accent hover:text-port-accent/80 rounded text-xs font-mono transition-colors border border-port-accent/30 min-h-[40px] shrink-0"
        title="Paste clipboard contents"
        aria-label="Paste clipboard contents"
      >
        <ClipboardPaste size={14} />
        <span className="hidden sm:inline">Paste</span>
      </button>
      {showPasteInput && (
        <input
          ref={pasteInputRef}
          type="text"
          className="w-32 px-2 py-1.5 bg-port-card text-white text-xs font-mono rounded border border-port-accent/50 focus:outline-none focus:border-port-accent min-h-[40px] placeholder-gray-500 shrink-0"
          placeholder="Tap & paste here"
          onPaste={handlePasteInputEvent}
          onBlur={() => setShowPasteInput(false)}
        />
      )}
      <div className="w-px h-6 bg-port-border shrink-0" />
      {/* Arrow / Enter hot buttons — touch-friendly TUI nav + shell history */}
      {NAV_KEYS.map((key) => (
        <button
          key={key.label}
          onClick={() => sendNavKey(key)}
          className="flex items-center justify-center px-2.5 py-1.5 bg-port-card hover:bg-port-border text-gray-300 hover:text-white rounded text-xs font-mono transition-colors border border-port-border min-h-[40px] min-w-[40px] shrink-0"
          title={`Send ${key.label} key`}
          aria-label={`Send ${key.label} key`}
        >
          <key.Icon size={14} />
        </button>
      ))}
    </>
  );
}
