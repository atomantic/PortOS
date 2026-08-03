import { useEffect, useRef, useState } from 'react';
import toast from '../components/ui/Toast';
import { setMusicVideoManualTempo } from '../services/apiMusicVideo.js';
import { clampBpm } from '../lib/metronome.js';

// Matches musicVideoManualAnalysisSchema's `bpm.max` on the server —
// clampBpm's own ceiling (320, metronome-focused) is looser than what the
// manual-tempo endpoint accepts.
const MANUAL_BPM_MAX = 300;

/**
 * Manual-tempo fallback for a music-video project: shown when the auto-detector
 * caches `bpm: null` (see server/services/musicVideo/audioAnalysis.js for why).
 * "Tap tempo" estimates BPM from the average interval between clicks (resets if
 * the gap since the last tap exceeds 2s, i.e. the director paused/restarted).
 *
 * The draft resets whenever the open project changes so a half-typed BPM can't
 * leak onto the next project. `onUpdated(project)` receives the persisted
 * project returned by the manual-tempo endpoint.
 */
export default function useMusicVideoManualTempo({ project, onUpdated } = {}) {
  const [bpm, setBpm] = useState('');
  const [offset, setOffset] = useState('0');
  const [saving, setSaving] = useState(false);
  const tapTimesRef = useRef([]);
  const projectId = project?.id;

  useEffect(() => {
    setBpm('');
    setOffset('0');
    tapTimesRef.current = [];
  }, [projectId]);

  const tap = () => {
    const now = Date.now();
    const taps = tapTimesRef.current;
    if (taps.length && now - taps[taps.length - 1] > 2000) taps.length = 0;
    taps.push(now);
    if (taps.length > 8) taps.shift();
    if (taps.length >= 2) {
      const intervals = [];
      for (let i = 1; i < taps.length; i++) intervals.push(taps[i] - taps[i - 1]);
      const avgMs = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      setBpm(String(Math.round(60000 / avgMs)));
    }
  };

  const submit = () => {
    if (!projectId) return;
    const parsed = clampBpm(bpm);
    if (parsed == null) { toast.error('Enter a BPM'); return; }
    const boundedBpm = Math.min(parsed, MANUAL_BPM_MAX);
    const offsetSec = Number(offset) || 0;
    setSaving(true);
    setMusicVideoManualTempo(projectId, { bpm: boundedBpm, offsetSec }, { silent: true })
      .then((proj) => {
        onUpdated?.(proj);
        toast.success(`Tempo set — ${proj.audioAnalysis?.bpm} BPM`);
        tapTimesRef.current = [];
      })
      .catch((err) => toast.error(err?.message || 'Could not set tempo'))
      .finally(() => setSaving(false));
  };

  return { bpm, setBpm, offset, setOffset, saving, tap, submit };
}
