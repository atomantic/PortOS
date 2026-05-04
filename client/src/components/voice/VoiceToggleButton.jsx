import { useEffect, useState } from 'react';
import { Mic, MicOff } from 'lucide-react';
import { getVoiceConfig } from '../../services/apiVoice';
import { onVoiceEvent } from '../../services/voiceClient';
import {
  VISIBILITY_EVENT,
  ENGAGE_EVENT,
  DISENGAGE_EVENT,
  readVoiceHidden,
  writeVoiceHidden,
  isVoiceHiddenStorageEvent,
} from '../../services/voiceVisibility';

export default function VoiceToggleButton({ className = '' }) {
  const [enabled, setEnabled] = useState(false);
  const [hidden, setHidden] = useState(readVoiceHidden);

  useEffect(() => {
    getVoiceConfig()
      .then((cfg) => setEnabled(!!cfg?.enabled))
      .catch(() => {});
    const off = onVoiceEvent('voice:config:changed', (cfg) => {
      if (typeof cfg?.enabled === 'boolean') setEnabled(cfg.enabled);
    });
    return off;
  }, []);

  useEffect(() => {
    const sync = () => setHidden(readVoiceHidden());
    const onStorage = (e) => { if (isVoiceHiddenStorageEvent(e)) sync(); };
    window.addEventListener(VISIBILITY_EVENT, sync);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(VISIBILITY_EVENT, sync);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  if (!enabled) return null;

  const engaged = !hidden;

  const toggle = () => {
    const next = !engaged;
    writeVoiceHidden(!next);
    window.dispatchEvent(new Event(next ? ENGAGE_EVENT : DISENGAGE_EVENT));
    setHidden(!next);
  };

  const Icon = engaged ? Mic : MicOff;

  return (
    <button
      type="button"
      onClick={toggle}
      className={`inline-flex items-center justify-center min-w-[40px] min-h-[40px] sm:min-w-0 sm:min-h-0 sm:p-1.5 rounded-lg transition-colors ${
        engaged ? 'text-port-accent' : 'text-gray-500 hover:text-white'
      } ${className}`}
      title={engaged ? 'Hide voice agent controls' : 'Engage voice agent controls'}
      aria-label={engaged ? 'Hide voice agent controls' : 'Engage voice agent controls'}
      aria-pressed={engaged}
    >
      <Icon size={18} />
    </button>
  );
}
