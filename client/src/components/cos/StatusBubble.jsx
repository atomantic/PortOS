import { STATE_MESSAGES } from './constants';

const GENERIC_MESSAGES = new Set(Object.values(STATE_MESSAGES));

// Generic per-state text ("Working on task...", "Idle - waiting...") duplicates
// the state label, so it shows as a compact pill overlaying the avatar instead
// of a bubble. Specific messages (task descriptions, health issues) keep the bubble.
export const isGenericStatusMessage = (message) => GENERIC_MESSAGES.has(message);

export function StatusPill({ state, message }) {
  const label = state === 'sleeping' ? 'Sleeping' : 'Working on task';
  return (
    <div
      className="absolute top-1 right-1 z-20 px-2.5 py-0.5 rounded-full text-xs font-mono bg-port-card/90 border border-port-border text-port-text-muted shadow-sm pointer-events-none"
      title={message}
    >
      {label}
    </div>
  );
}

export default function StatusBubble({ message }) {
  return (
    <div className="mt-4 px-4 py-3 rounded-2xl max-w-[280px] text-center text-sm leading-relaxed bg-port-accent-2/10 border border-port-accent-2/30">
      {message}
    </div>
  );
}
