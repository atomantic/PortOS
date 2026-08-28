/**
 * MicProcessingHint — one-line warning shown when the browser kept its speech
 * processing chain on despite a pitch-analysis mic asking for it off (Safari
 * and Firefox both do, for some stages). Renders nothing when every stage was
 * honored, and nothing when the browser doesn't report what it applied — an
 * unknown stage is not evidence of a problem.
 */

import { AlertTriangle } from 'lucide-react';
import { hasUnwantedProcessing } from '../../lib/audioRecorder.js';

const LABELS = {
  echoCancellation: 'echo cancellation',
  noiseSuppression: 'noise suppression',
  autoGainControl: 'automatic gain control',
};

export default function MicProcessingHint({ processing = null }) {
  if (!hasUnwantedProcessing(processing)) return null;
  const on = Object.keys(LABELS).filter((key) => processing[key] === true).map((key) => LABELS[key]);
  return (
    <p className="flex items-start gap-1.5 mt-2 text-xs text-port-warning">
      <AlertTriangle size={13} className="shrink-0 mt-0.5" />
      <span>Browser audio processing is on ({on.join(', ')}) — pitch readings may drift.</span>
    </p>
  );
}
