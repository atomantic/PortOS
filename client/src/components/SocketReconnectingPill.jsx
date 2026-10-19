import { useEffect, useState } from 'react';
import { WifiOff } from 'lucide-react';
import Pill from './ui/Pill.jsx';
import { useSocketConnected } from '../hooks/useSocket.js';

/**
 * How long the shared socket may stay disconnected before the pill shows.
 * A server restart or a Wi-Fi blip reconnects well inside this window, so
 * the pill marks a real outage (sleep, Tailscale re-establishing) rather
 * than flashing on every PM2 reload.
 */
export const RECONNECTING_PILL_DELAY_MS = 10_000;

/**
 * Small "Reconnecting…" status pill for the app shell. Every live view in
 * PortOS is push-driven, so a dead socket leaves the page looking current
 * while silently frozen (#12027); this is the one shared surface that says
 * so. Mounted once from Layout.jsx.
 */
export default function SocketReconnectingPill() {
  const connected = useSocketConnected();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (connected) {
      setVisible(false);
      return undefined;
    }
    const timer = setTimeout(() => setVisible(true), RECONNECTING_PILL_DELAY_MS);
    return () => clearTimeout(timer);
  }, [connected]);

  if (!visible) return null;
  return (
    <div className="fixed top-2 left-1/2 -translate-x-1/2 z-[60] pointer-events-none print:hidden">
      <Pill tone="warning" icon={WifiOff} role="status" aria-live="polite" className="shadow-lg bg-port-card">
        Reconnecting…
      </Pill>
    </div>
  );
}
