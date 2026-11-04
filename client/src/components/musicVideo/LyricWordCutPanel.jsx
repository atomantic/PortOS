import { useState } from 'react';
import { Scissors, X } from 'lucide-react';
import { timedSongScenes } from '../../../../server/lib/musicVideoColdOpen.js';
import { lyricWordCuts } from '../../../../server/lib/musicVideoLyricAnchors.js';
import { formatCount, formatTimecode } from '../../utils/formatters.js';

const MODES = [['phrase', 'One shot per phrase'], ['word', 'One shot per word']];
const fieldCls = 'bg-port-bg border border-port-border rounded px-1.5 py-1 text-xs min-h-[44px] sm:min-h-0 max-w-full';
const buttonCls = 'flex items-center gap-1 bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm min-h-[44px] sm:min-h-0 disabled:opacity-50';

const lineLabel = (cue, i) => {
  const at = cue.words?.[0]?.startSec ?? cue.startSec;
  const text = cue.text.trim();
  return `${i + 1}. ${typeof at === 'number' ? `${formatTimecode(at)} ` : ''}${text.length > 48 ? `${text.slice(0, 47)}…` : text}`;
};

/** What the last word re-alignment did to word-anchored shots, until dismissed. */
function AnchorSyncNote({ project, onDismiss }) {
  const sync = project.lyricAnchorSync;
  if (!sync) return null;
  const scenes = project.scenes || [];
  const name = (id) => {
    const i = scenes.findIndex((s) => s.sceneId === id);
    return i < 0 ? null : scenes[i].label || `Shot ${i + 1}`;
  };
  const moved = (sync.moved || []).filter((m) => name(m.sceneId));
  const stuck = [...(sync.unresolved || []), ...(sync.blocked || [])].map(name).filter(Boolean);
  if (!moved.length && !stuck.length) return null;
  return (
    <div className="flex items-start gap-2 rounded border border-port-border bg-port-bg p-2 text-xs" role="status">
      <div className="min-w-0 flex-1 space-y-1">
        {moved.length > 0 && <p>{formatCount(moved.length)} {moved.length === 1 ? 'shot' : 'shots'} followed {moved.length === 1 ? 'its word' : 'their words'}: {moved.map((m) => {
          const delta = m.toSec - m.fromSec;
          return `${name(m.sceneId)} (${delta > 0 ? '+' : ''}${delta.toFixed(2)}s)`;
        }).join(', ')}</p>}
        {stuck.length > 0 && <p className="text-port-warning">Not moved (word gone or no room): {stuck.join(', ')}</p>}
      </div>
      <button type="button" onClick={onDismiss} aria-label="Dismiss" className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded text-port-text-muted hover:text-port-text">
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * Cut the board on sung words (#14820): pick a run of lyric lines and make one
 * shot per phrase or per word, each starting on its word and following it when
 * the words are re-aligned. Needs word timing (Align words on the Song step).
 * A board with no timed shots has nothing to cut, so it offers to lay them out over
 * the lines instead. Hidden when the storyboard comes from a document's shot
 * manifest; a document project whose shots live on the Board keeps it (#14846).
 */
export default function LyricWordCutPanel({ project, onCut, onDismissSync }) {
  const cues = (project.lyricCues || []).filter((cue) => typeof cue?.text === 'string' && cue.text.trim());
  const [fromId, setFromId] = useState(cues[0]?.id ?? '');
  const [toId, setToId] = useState(cues[0]?.id ?? '');
  const [mode, setMode] = useState('phrase');
  const [busy, setBusy] = useState(false);
  if (!cues.length || project.productionReview?.draft?.storyboardSource === 'document') return null;
  const layOut = timedSongScenes(project).length === 0;
  const at = (id) => Math.max(0, cues.findIndex((cue) => cue.id === id));
  const [lo, hi] = [at(fromId), at(toId)].sort((a, b) => a - b);
  const cueIds = cues.slice(lo, hi + 1).map((cue) => cue.id);
  const { cuts, untimed } = lyricWordCuts(cues, cueIds, mode);
  const cut = () => {
    setBusy(true);
    Promise.resolve(onCut({ cueIds, mode })).finally(() => setBusy(false));
  };
  return (
    <div className="min-w-0 space-y-2" role="group" aria-label="Cut on lyric words">
      <h4 className="text-sm font-medium">Cut on lyric words</h4>
      <AnchorSyncNote project={project} onDismiss={onDismissSync} />
      <div className="flex min-w-0 flex-wrap items-end gap-2 text-xs">
        <div className="min-w-0">
          <label htmlFor="mv-lyric-cut-from" className="mb-0.5 block text-port-text-muted">From line</label>
          <select id="mv-lyric-cut-from" value={cues[at(fromId)].id} onChange={(e) => setFromId(e.target.value)} className={fieldCls}>
            {cues.map((cue, i) => <option key={cue.id} value={cue.id}>{lineLabel(cue, i)}</option>)}
          </select>
        </div>
        <div className="min-w-0">
          <label htmlFor="mv-lyric-cut-to" className="mb-0.5 block text-port-text-muted">To line</label>
          <select id="mv-lyric-cut-to" value={cues[at(toId)].id} onChange={(e) => setToId(e.target.value)} className={fieldCls}>
            {cues.map((cue, i) => <option key={cue.id} value={cue.id}>{lineLabel(cue, i)}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="mv-lyric-cut-mode" className="mb-0.5 block text-port-text-muted">Shots</label>
          <select id="mv-lyric-cut-mode" value={mode} onChange={(e) => setMode(e.target.value)} className={fieldCls}>
            {MODES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
        <button type="button" onClick={cut} disabled={busy || untimed.length > 0 || !cuts.length} className={buttonCls}>
          <Scissors size={15} aria-hidden="true" />{busy ? (layOut ? 'Laying out…' : 'Cutting…') : `${layOut ? 'Lay out' : 'Cut'} ${formatCount(cuts.length)} ${cuts.length === 1 ? 'shot' : 'shots'}`}
        </button>
      </div>
      <p className="text-xs text-port-text-muted">
        {untimed.length > 0
          ? <span className="text-port-warning">Align words on the Song step first: {formatCount(untimed.length)} {untimed.length === 1 ? 'line has' : 'lines have'} no word timing.</span>
          : `${layOut ? `No timed shots yet, so this lays out one shot per ${mode} over the chosen lines. ` : ''}Each shot starts on its first word and moves with it when the words are re-aligned.`}
      </p>
    </div>
  );
}
