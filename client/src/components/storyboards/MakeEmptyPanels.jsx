import { useEffect, useState } from 'react';
import { Loader2, RefreshCw, Wand2 } from 'lucide-react';
import InlineConfirmRow from '../ui/InlineConfirmRow';
import ProgressBar from '../ui/ProgressBar';
import toast from '../ui/Toast';
import socket from '../../services/socket';
import { getStoryboardMakeEmpty, startStoryboardMakeEmpty } from '../../services/api';
import { formatCount } from '../../utils/formatters';

const plural = (n, word) => `${formatCount(n)} ${word}${n === 1 ? '' : 's'}`;

function planQuestion({ panelCount, allCount, steps }, redraw) {
  const parts = steps.map((step) => (step.type === 'image'
    ? `${step.title} makes ${plural(redraw ? 1 : step.frames, 'frame')} each with ${step.model}`
    : `${step.title} ${redraw ? 'rewrites each prompt' : 'runs'} on ${step.model}`));
  return redraw
    ? `Redraw all ${plural(allCount, 'panel')}? ${parts.join('; ')}. Earlier drawings stay as takes.`
    : `Make ${plural(panelCount, 'empty panel')}? ${parts.join('; ')}. Prompts already written are kept.`;
}

/**
 * "Make empty panels" runs the board's recipe on every panel with no art;
 * "Redraw all" runs it on every panel (a new art style, a reworked story):
 * each prompt is rewritten and one frame drawn, which becomes the panel's art
 * unless the user unticks "Select the new drawings". The confirm names each
 * model and the panel count before anything runs; progress arrives on
 * `storyboard:make-batch` (the panels' own frames still arrive on
 * `storyboard:make`, which the page already follows).
 */
export default function MakeEmptyPanels({ boardId }) {
  const [batch, setBatch] = useState(null);
  const [plan, setPlan] = useState(null);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState('');
  const [selectNew, setSelectNew] = useState(true);

  useEffect(() => {
    let active = true;
    // Counts batch events: a read issued before the newest one is older than it.
    let events = 0;
    // A batch started in another tab, or before a reload, is still shown. Re-read
    // on reconnect: a `done` missed while offline, or a server restart that
    // dropped the batch, would otherwise leave the progress bar up for good.
    const read = () => {
      const seen = events;
      getStoryboardMakeEmpty(boardId, { silent: true })
        .then((res) => { if (active && seen === events) setBatch(res?.batch || null); })
        .catch(() => {});
    };
    read();
    const onBatch = (evt) => {
      if (evt?.storyboardId !== boardId) return;
      events += 1;
      if (evt.status !== 'done') { setBatch(evt); return; }
      setBatch(null);
      const made = evt.done - evt.failed;
      const verb = evt.redraw ? 'Redrew' : 'Made';
      if (evt.failed) toast.error(`${verb} ${plural(made, 'panel')}; ${plural(evt.failed, 'panel')} could not be made. Open one to see why.`);
      else toast.success(`${verb} ${plural(made, 'panel')}.`);
    };
    socket.on('storyboard:make-batch', onBatch);
    socket.on('connect', read);
    return () => {
      active = false;
      socket.off('storyboard:make-batch', onBatch);
      socket.off('connect', read);
    };
  }, [boardId]);

  const openConfirm = async (redraw) => {
    setLoading(redraw ? 'redraw' : 'empty');
    setNote('');
    setPlan(null);
    const next = await getStoryboardMakeEmpty(boardId).catch(() => null);
    setLoading(false);
    if (!next) return;
    if (next.batch) { setBatch(next.batch); return; }
    if (!(redraw ? next.allCount : next.panelCount)) { setNote(redraw ? 'Every panel is already drawing.' : 'Every panel already has art.'); return; }
    if (!next.steps.some((step) => step.type === 'image')) { setNote('The recipe has no Image node, so there is nothing to make.'); return; }
    setPlan({ ...next, redraw });
  };

  const start = async () => {
    const { redraw } = plan;
    setPlan(null);
    const res = await startStoryboardMakeEmpty(boardId, redraw ? { redraw: true, selectNew } : {}).catch(() => null);
    if (res?.batch) setBatch(res.batch);
  };
  const buttonClass = 'min-h-[44px] inline-flex items-center gap-1.5 rounded border border-port-border px-3 text-sm text-gray-200 hover:border-port-accent/60 hover:text-white disabled:opacity-40';

  if (batch) {
    return (
      <div className="flex min-h-[44px] min-w-[12rem] flex-1 items-center gap-2 sm:flex-none">
        <ProgressBar percent={(batch.done / batch.total) * 100} label={batch.redraw ? 'Redrawing panels' : 'Making empty panels'} className="flex-1" />
        <span className="text-xs text-gray-400 tabular-nums shrink-0">{formatCount(batch.done)} of {formatCount(batch.total)}</span>
      </div>
    );
  }
  return (
    <>
      <button type="button" onClick={() => openConfirm(false)} disabled={!!loading} className={buttonClass}>
        {loading === 'empty' ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Wand2 size={16} aria-hidden="true" />} Make empty panels
      </button>
      <button type="button" onClick={() => openConfirm(true)} disabled={!!loading} className={buttonClass}>
        {loading === 'redraw' ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={16} aria-hidden="true" />} Redraw all
      </button>
      {note && <p role="status" className="basis-full text-xs text-gray-400">{note}</p>}
      {plan && (
        <div className="basis-full space-y-1">
          <InlineConfirmRow autoFocus aria-label={plan.redraw ? 'Redraw all panels' : 'Make empty panels'} tone="warning"
            confirmText={plan.redraw ? 'Redraw' : 'Make'} question={planQuestion(plan, plan.redraw)} onConfirm={start} onCancel={() => setPlan(null)} />
          {plan.redraw && (
            <label htmlFor="storyboard-redraw-select-new" className="flex min-h-[44px] items-center gap-2 text-sm text-gray-300">
              <input id="storyboard-redraw-select-new" type="checkbox" checked={selectNew} onChange={(event) => setSelectNew(event.target.checked)} />
              Select the new drawings
            </label>
          )}
        </div>
      )}
    </>
  );
}
