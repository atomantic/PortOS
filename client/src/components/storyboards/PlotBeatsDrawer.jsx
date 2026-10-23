import { useEffect, useState } from 'react';
import { Loader2, Plus, Sparkles } from 'lucide-react';
import Drawer from '../Drawer';
import MusicVideoLlmPicker from '../musicVideo/MusicVideoLlmPicker';
import SentPromptPanel from '../media/SentPromptPanel';
import { addStoryboardBeats, extractStoryboardBeats, updateStoryboard } from '../../services/api';
import { formatCount, formatTimecode } from '../../utils/formatters';
import { BEAT_EXTRACT_LIMITS } from '../../../../server/lib/storyboardBeatExtract.js';
import { newStoryboardEntityId } from '../../../../server/lib/storyboardVocabulary.js';

const actionButton = 'min-h-[44px] inline-flex items-center justify-center gap-1.5 rounded-lg border border-port-border px-3 text-sm text-gray-200 hover:border-port-accent/60 hover:text-white disabled:opacity-40';
const plural = (n, word) => `${formatCount(n)} ${word}${n === 1 ? '' : 's'}`;

/**
 * Beats from plot: the user's plot summary goes to the provider › model ›
 * effort they pick, and the beats (with panels) come back as a preview. The
 * user unticks any they don't want and adds the rest after the board's last
 * beat; nothing reaches the board before that. The plot and the pick are
 * kept on the board, so the drawer opens where it was left.
 */
export default function PlotBeatsDrawer({ open, board, onClose, onBoard }) {
  const [plot, setPlot] = useState(board.plot || '');
  const [pick, setPick] = useState(board.plotLlm || { providerId: '', model: '', effort: '' });
  const [running, setRunning] = useState(false);
  const [adding, setAdding] = useState(false);
  const [preview, setPreview] = useState(null);
  const [kept, setKept] = useState(new Set());

  // A plot saved from another tab, or by the last extract, shows when nothing is typed here.
  useEffect(() => {
    setPlot((prev) => (prev ? prev : board.plot || ''));
  }, [board.plot]);

  const savePlot = () => {
    if (plot !== (board.plot || '')) updateStoryboard(board.id, { plot }).then(onBoard).catch(() => {});
  };

  const extract = async () => {
    setRunning(true);
    const res = await extractStoryboardBeats(board.id, { plot, ...pick }).catch(() => null);
    setRunning(false);
    if (!res) return;
    onBoard(res.board);
    // A preview row has no id until it is added; a local key tracks the ticks.
    const beats = res.beats.map((beat) => ({ ...beat, key: newStoryboardEntityId('preview') }));
    setPreview({ ...res, beats });
    setKept(new Set(beats.map((beat) => beat.key)));
  };

  const add = async () => {
    const beats = preview.beats.filter((beat) => kept.has(beat.key)).map(({ key: _key, ...beat }) => beat);
    setAdding(true);
    const next = await addStoryboardBeats(board.id, beats).catch(() => null);
    setAdding(false);
    if (!next) return;
    onBoard(next);
    setPreview(null);
    onClose();
  };

  const toggle = (key) => setKept((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

  const over = plot.length > BEAT_EXTRACT_LIMITS.plot;
  return (
    <Drawer open={open} onClose={onClose} title="Beats from plot" subtitle={board.name} size="md" closeLabel="Close beats from plot">
      <div className="space-y-3">
        <div>
          <label htmlFor="storyboard-plot" className="block text-[11px] text-gray-500 mb-0.5">Plot summary</label>
          <textarea id="storyboard-plot" value={plot} onChange={(e) => setPlot(e.target.value)} onBlur={savePlot} rows={8}
            placeholder="The story in your own words: who, what happens, how it ends."
            className="w-full min-h-[10rem] bg-port-bg border border-port-border rounded p-2 text-sm text-white" />
          <p className={`text-[11px] tabular-nums ${over ? 'text-port-error' : 'text-gray-500'}`} {...(over ? { role: 'alert' } : {})}>
            {formatCount(plot.length)} / {formatCount(BEAT_EXTRACT_LIMITS.plot)} characters{over ? ': shorten it to send it' : ''}
          </p>
        </div>
        <MusicVideoLlmPicker idPrefix="storyboard-plot" label="Model" value={pick} onChange={setPick}
          emptyProviderOption="Default (active provider)" fallbackName="The active provider" hint={null} />
        <button type="button" onClick={extract} disabled={running || !plot.trim() || over} className={`${actionButton} bg-port-accent/20 border-port-accent/50`}>
          {running ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Sparkles size={16} aria-hidden="true" />}
          {running ? 'Reading the plot…' : 'Draw beats'}
        </button>

        {preview && (
          <div className="space-y-2">
            <SentPromptPanel prompt={plot} sentPrompt={preview.sentPrompt} additions={preview.promptAdditions} />
            <p className="text-xs text-gray-400">{plural(preview.beats.length, 'beat')} from {preview.model || preview.providerId}. Untick any you don't want.</p>
            <ol className="space-y-2" aria-label="Beats from the plot">
              {preview.beats.map((beat, index) => {
                const seconds = beat.panels.reduce((sum, panel) => sum + (panel.seconds || 0), 0);
                return (
                  <li key={beat.key} className="rounded-lg border border-port-border p-2">
                    <label className="flex items-start gap-2">
                      <input type="checkbox" checked={kept.has(beat.key)} onChange={() => toggle(beat.key)} className="mt-1 h-4 w-4" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm text-white">
                          {beat.title || `Beat ${index + 1}`}
                          {beat.musicalRole && <span className="ml-2 text-[11px] text-gray-400">{beat.musicalRole}</span>}
                          {seconds > 0 && <span className="ml-2 text-[11px] text-gray-500 tabular-nums">{formatTimecode(seconds)}</span>}
                        </span>
                        {beat.what && <span className="block text-xs text-gray-400">{beat.what}</span>}
                        <span className="mt-1 block text-[11px] text-gray-500">
                          {beat.panels.map((panel) => panel.action || panel.dialogue).join(' · ') || 'No panels'}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ol>
            <button type="button" onClick={add} disabled={adding || !kept.size} className={`${actionButton} bg-port-accent/20 border-port-accent/50`}>
              <Plus size={16} aria-hidden="true" /> Add {plural(kept.size, 'beat')}
            </button>
          </div>
        )}
      </div>
    </Drawer>
  );
}
