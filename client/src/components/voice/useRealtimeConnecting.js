import { useEffect, useState } from 'react';
import { REALTIME_ACTIVE_EVENT, isRealtimeCallActive, isRealtimeCallConnecting } from '../../services/voiceRealtime';

/** Live realtime call status: whether a speech-to-speech call is active and whether its model is still loading. */
export function useRealtimeCallState() {
  const [state, setState] = useState(() => ({
    active: isRealtimeCallActive(),
    connecting: isRealtimeCallConnecting(),
  }));
  useEffect(() => {
    const onChange = (event) => setState({
      active: Boolean(event.detail?.active),
      connecting: Boolean(event.detail?.connecting),
    });
    window.addEventListener(REALTIME_ACTIVE_EVENT, onChange);
    return () => window.removeEventListener(REALTIME_ACTIVE_EVENT, onChange);
  }, []);
  return state;
}

/** True while a realtime call is starting and its voice model is still loading. */
export default function useRealtimeConnecting() {
  return useRealtimeCallState().connecting;
}
