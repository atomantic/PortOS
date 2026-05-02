import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Timer, Play, StopCircle, X } from 'lucide-react';
import toast from '../ui/Toast';
import {
  listWritersRoomExercises,
  createWritersRoomExercise,
  finishWritersRoomExercise,
  discardWritersRoomExercise,
} from '../../services/apiWritersRoom';
import { countWords, formatCountdown } from '../../utils/formatters';

const DURATION_PRESETS = [
  { label: '5 min', seconds: 300 },
  { label: '10 min', seconds: 600 },
  { label: '15 min', seconds: 900 },
  { label: '25 min', seconds: 1500 },
];

export default function ExercisePanel({ activeWork, onClose }) {
  const [history, setHistory] = useState([]);
  const [duration, setDuration] = useState(600);
  const [prompt, setPrompt] = useState('');
  const [active, setActive] = useState(null); // { id, startedAt, durationSeconds, startingWords }
  const [now, setNow] = useState(Date.now());
  const [text, setText] = useState('');
  const tickRef = useRef(null);

  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const refresh = useCallback(async () => {
    const all = await listWritersRoomExercises(activeWork?.id).catch(() => []);
    if (mountedRef.current) setHistory(all);
  }, [activeWork?.id]);

  useEffect(() => { refresh(); }, [refresh]);

  // 1Hz tick while a session is running
  useEffect(() => {
    if (!active) return;
    tickRef.current = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tickRef.current);
  }, [active]);

  const elapsed = active ? Math.floor((now - new Date(active.startedAt).getTime()) / 1000) : 0;
  const remaining = active ? active.durationSeconds - elapsed : duration;
  const wordsAdded = useMemo(() => countWords(text), [text]);
  const expired = active && remaining <= 0;

  const start = async () => {
    // Word count lives on the active draft metadata, not the work root, so
    // walk drafts → activeDraftVersionId before falling back to a top-level
    // wordCount (which only the listWorks summary exposes).
    const activeDraft = activeWork?.drafts?.find((d) => d.id === activeWork?.activeDraftVersionId);
    const startingWords = activeDraft?.wordCount ?? activeWork?.wordCount ?? 0;
    const session = await createWritersRoomExercise({
      workId: activeWork?.id ?? null,
      prompt: prompt.trim(),
      durationSeconds: duration,
      startingWords,
    }).catch((err) => {
      toast.error(`Failed to start: ${err.message}`);
      return null;
    });
    if (!session) return;
    setActive(session);
    setText('');
    setNow(Date.now());
  };

  const finishSession = async ({ keep } = { keep: true }) => {
    if (!active) return;
    if (keep) {
      const startingWords = active.startingWords || 0;
      await finishWritersRoomExercise(active.id, {
        endingWords: startingWords + wordsAdded,
        appendedText: text || null,
      }).catch((err) => toast.error(`Finish failed: ${err.message}`));
      toast.success(`Logged ${wordsAdded} words`);
    } else {
      await discardWritersRoomExercise(active.id).catch((err) => toast.error(`Discard failed: ${err.message}`));
    }
    setActive(null);
    setText('');
    await refresh();
  };

  // Toast once when the timer crosses into expired. The ref guards against
  // multiple fires if `expired` stays true across re-renders.
  const expiredToastedRef = useRef(false);
  useEffect(() => {
    if (!expired) {
      expiredToastedRef.current = false;
      return;
    }
    if (expiredToastedRef.current) return;
    expiredToastedRef.current = true;
    toast('Timer up — finish or keep going', { icon: '⏰' });
  }, [expired]);

  return (
    <div className="bg-port-card border border-port-border rounded-lg overflow-hidden flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-port-border bg-port-bg/40">
        <Timer size={14} className="text-port-accent" />
        <h3 className="text-sm font-semibold text-white flex-1">Write for {Math.round(duration / 60)}</h3>
        <button onClick={onClose} className="text-gray-500 hover:text-white" aria-label="Close exercise">
          <X size={14} />
        </button>
      </div>

      {!active && (
        <div className="px-3 py-3 space-y-3">
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-gray-500 mb-1">Duration</label>
            <div className="flex flex-wrap gap-1">
              {DURATION_PRESETS.map(({ label, seconds }) => (
                <button
                  key={seconds}
                  onClick={() => setDuration(seconds)}
                  className={`px-2 py-1 text-xs rounded ${duration === seconds ? 'bg-port-accent text-white' : 'bg-port-bg border border-port-border text-gray-300'}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-[10px] uppercase tracking-wider text-gray-500 mb-1">
              Prompt {activeWork && <span className="text-gray-600">(or leave blank to free-write {activeWork.title})</span>}
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="What should this session focus on?"
              rows={2}
              className="w-full bg-port-bg border border-port-border rounded px-2 py-1 text-xs"
            />
          </div>

          <button
            onClick={start}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-port-accent text-white text-sm font-medium rounded hover:bg-port-accent/80"
          >
            <Play size={14} /> Start
          </button>
        </div>
      )}

      {active && (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="px-3 py-2 border-b border-port-border bg-port-bg/40 flex items-center gap-3">
            <div className={`text-2xl font-mono ${expired ? 'text-port-error' : 'text-white'}`}>
              {formatCountdown(remaining)}
            </div>
            <div className="flex-1 text-xs text-gray-400">
              <div>{wordsAdded} words this session</div>
              {prompt && <div className="text-gray-500 italic truncate">{prompt}</div>}
            </div>
            <button onClick={() => finishSession({ keep: true })}
              className="flex items-center gap-1 px-2 py-1 bg-port-success/20 text-port-success text-xs rounded hover:bg-port-success/30"
              title="Save this session"
            >
              <StopCircle size={12} /> Finish
            </button>
            <button onClick={() => finishSession({ keep: false })}
              className="flex items-center gap-1 px-2 py-1 text-gray-500 text-xs rounded hover:text-port-error"
              title="Discard"
            >
              <X size={12} />
            </button>
          </div>
          <textarea
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Just write…"
            className="flex-1 resize-none bg-port-bg text-gray-100 px-3 py-2 text-sm focus:outline-none"
            spellCheck
          />
        </div>
      )}

      <div className="border-t border-port-border bg-port-bg/40 px-3 py-2 max-h-40 overflow-y-auto">
        <h4 className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">Recent sessions</h4>
        {history.length === 0 && <p className="text-[11px] text-gray-600">No sessions yet</p>}
        <ul className="space-y-1">
          {history.slice(0, 8).map((ex) => (
            <li key={ex.id} className="text-[11px] flex items-center gap-2">
              <span className={`w-1.5 h-1.5 rounded-full ${
                ex.status === 'finished' ? 'bg-port-success' :
                ex.status === 'discarded' ? 'bg-gray-500' :
                'bg-port-warning animate-pulse'
              }`} />
              <span className="text-gray-300">
                {ex.status === 'finished' ? `${ex.wordsAdded ?? 0} words` : ex.status}
              </span>
              <span className="text-gray-600 truncate flex-1">{ex.prompt || '(free-write)'}</span>
              <span className="text-gray-600">{Math.round((ex.durationSeconds || 0) / 60)}m</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
