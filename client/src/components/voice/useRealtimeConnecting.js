import { useEffect, useState } from 'react';
import { REALTIME_ACTIVE_EVENT, isRealtimeCallConnecting } from '../../services/voiceRealtime';

/** True while a realtime call is starting and its voice model is still loading. */
export default function useRealtimeConnecting() {
  const [connecting, setConnecting] = useState(isRealtimeCallConnecting);
  useEffect(() => {
    const onChange = (event) => setConnecting(Boolean(event.detail?.connecting));
    window.addEventListener(REALTIME_ACTIVE_EVENT, onChange);
    return () => window.removeEventListener(REALTIME_ACTIVE_EVENT, onChange);
  }, []);
  return connecting;
}
