import { useEffect, useState } from 'react';
import { Loader2, Wand2 } from 'lucide-react';
import InlineConfirmRow from '../ui/InlineConfirmRow';
import ProgressBar from '../ui/ProgressBar';
import toast from '../ui/Toast';
import socket from '../../services/socket';
import { getStoryboardMakeEmpty, startStoryboardMakeEmpty } from '../../services/api';
import { formatCount } from '../../utils/formatters';

const plural = (n, word) => `${formatCount(n)} ${word}${n === 1 ? '' : 's'}`;

function planQuestion({ panelCount, steps }) {
  const parts = steps.map((step) => (step.type === 'image'
    ? `${step.title} makes ${plural(step.frames, 'frame')} each with ${step.model}`
    : `${step.title} runs on ${step.model}`));
  return `Make ${plural(panelCount, 'empty panel')}? ${parts.join('; ')}. Prompts already written are kept.`;
}

/**
 * "Make empty panels": runs the board's recipe on every panel with no art.
 * The confirm names each model and the panel count before anything runs;
 * progress arrives on `storyboard:make-batch` (the panels' own frames still
 * arrive on `storyboard:make`, which the page already follows).
 */
export default function MakeEmptyPanels({ boardId }) {
  const [batch, setBatch] = useState(null);
  const [plan, setPlan] = useState(null);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState('');

  useEffect(() => {
    let active = true;
    // A batch started in another tab, or before a reload, is still shown.
    getStoryboardMakeEmpty(boardId, { silent: true })
      .then((res) => { if (active) setBatch(res?.batch || null); })
      .catch(() => {});
    const onBatch = (evt) => {
      if (evt?.storyboardId !== boardId) return;
      if (evt.status !== 'done') { setBatch(evt); return; }
      setBatch(null);
      const made = evt.done - evt.failed;
      if (evt.failed) toast.error(`Made ${plural(made, 'panel')}; ${plural(evt.failed, 'panel')} could not be made. Open one to see why.`);
      else toast.success(`Made ${plural(made, 'panel')}.`);
    };
    socket.on('storyboard:make-batch', onBatch);
    return () => {
      active = false;
      socket.off('storyboard:make-batch', onBatch);
    };
  }, [boardId]);

  const openConfirm = async () => {
    setLoading(true);
    setNote('');
    const next = await getStoryboardMakeEmpty(boardId).catch(() => null);
    setLoading(false);
    if (!next) return;
    if (next.batch) { setBatch(next.batch); return; }
    if (!next.panelCount) { setNote('Every panel already has art.'); return; }
    if (!next.steps.some((step) => step.type === 'image')) { setNote('The recipe has no Image node, so there is nothing to make.'); return; }
    setPlan(next);
  };

  const start = async () => {
    setPlan(null);
    const res = await startStoryboardMakeEmpty(boardId).catch(() => null);
    if (res?.batch) setBatch(res.batch);
  };

  if (batch) {
    return (
      <div className="flex min-h-[44px] min-w-[12rem] flex-1 items-center gap-2 sm:flex-none">
        <ProgressBar percent={(batch.done / batch.total) * 100} label="Making empty panels" className="flex-1" />
        <span className="text-xs text-gray-400 tabular-nums shrink-0">{formatCount(batch.done)} of {formatCount(batch.total)}</span>
      </div>
    );
  }
  return (
    <>
      <button type="button" onClick={openConfirm} disabled={loading}
        className="min-h-[44px] inline-flex items-center gap-1.5 rounded border border-port-border px-3 text-sm text-gray-200 hover:border-port-accent/60 hover:text-white disabled:opacity-40">
        {loading ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Wand2 size={16} aria-hidden="true" />} Make empty panels
      </button>
      {note && <p role="status" className="basis-full text-xs text-gray-400">{note}</p>}
      {plan && (
        <InlineConfirmRow autoFocus aria-label="Make empty panels" className="basis-full" tone="warning" confirmText="Make"
          question={planQuestion(plan)} onConfirm={start} onCancel={() => setPlan(null)} />
      )}
    </>
  );
}
