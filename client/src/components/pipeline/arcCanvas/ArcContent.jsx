import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import toast from '../../ui/Toast';
import { updatePipelineSeries } from '../../../services/api';
import { ArcShapePicker, ArcShapeSparkline, getStoryShape } from '../StoryShapes';
import FieldLockToggle from './FieldLockToggle.jsx';
import TickingClockEditor from './TickingClockEditor.jsx';
import TickingClockCard from './TickingClockCard.jsx';
import ThemeChips from './ThemeChips.jsx';
import SeriesDesignEditor from './SeriesDesignEditor.jsx';

export default function ArcContent({ series, onSeriesUpdate, onRegisterDraftFlush }) {
  const arc = series.arc || {};
  const locked = series.locked?.arc === true;
  const saveRef = useRef(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(arc);
  const [saving, setSaving] = useState(false);
  const [arcDetailsOpen, setArcDetailsOpen] = useState(false);

  const startEdit = () => {
    setDraft({ ...arc });
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setDraft(arc);
  };

  // Latest editor state for the host-driven flush below, which is registered
  // once and would otherwise close over the first render's draft.
  const stateRef = useRef(null);
  stateRef.current = { editing, draft, arc };

  const persistDraft = useCallback(async (nextDraft) => {
    if (saveRef.current) return saveRef.current;
    if (series.locked?.arc === true) return null;
    setSaving(true);
    saveRef.current = updatePipelineSeries(series.id, { arc: nextDraft }, { silent: true }).catch((err) => {
      toast.error(err.message || 'Save failed');
      return null;
    });
    const updated = await saveRef.current;
    saveRef.current = null;
    setSaving(false);
    if (!updated) return null;
    onSeriesUpdate(updated);
    setEditing(false);
    return updated;
  }, [series.id, series.locked?.arc, onSeriesUpdate]);

  const save = async () => {
    if (await persistDraft(draft)) toast.success('Arc saved');
  };

  // Hand the host a committer for the OPEN editor, so any "flush before you
  // act" path (Lock & continue, Generate arc, Save series) persists what is on
  // screen instead of silently discarding it (#3907). Returns `true` only when
  // it actually wrote; null means a failed save and blocks dependent actions. Unregisters on unmount so a torn-down editor can never
  // be committed.
  useEffect(() => {
    if (!onRegisterDraftFlush) return undefined;
    onRegisterDraftFlush(async () => {
      const { editing: isEditing, draft: pending, arc: current } = stateRef.current;
      if (!isEditing || JSON.stringify(pending ?? null) === JSON.stringify(current ?? null)) return false;
      return (await persistDraft(pending)) ? true : null;
    });
    return () => onRegisterDraftFlush(null);
  }, [onRegisterDraftFlush, persistDraft]);

  if (editing) {
    return (
      <fieldset disabled={saving || locked} className="space-y-2">
        <SeriesDesignEditor value={draft.seriesDesign} onChange={(seriesDesign) => setDraft({ ...draft, seriesDesign })} />
        <textarea
          aria-label="Logline"
          value={draft.logline || ''}
          onChange={(e) => setDraft({ ...draft, logline: e.target.value })}
          placeholder="One-sentence whole-arc pitch"
          rows={2}
          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
          maxLength={500}
        />
        <textarea
          aria-label="Summary"
          value={draft.summary || ''}
          onChange={(e) => setDraft({ ...draft, summary: e.target.value })}
          placeholder="Multi-volume / multi-season summary (~500 words)"
          rows={6}
          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
          maxLength={8000}
        />
        <textarea
          aria-label="Protagonist arc"
          value={draft.protagonistArc || ''}
          onChange={(e) => setDraft({ ...draft, protagonistArc: e.target.value })}
          placeholder="Protagonist arc across all volumes / seasons"
          rows={3}
          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm"
          maxLength={4000}
        />
        <ArcShapePicker
          value={draft.shape || null}
          onChange={(shape) => setDraft({ ...draft, shape })}
          disabled={saving}
        />
        <TickingClockEditor
          clock={draft.tickingClock}
          disabled={saving}
          onChange={(tickingClock) => setDraft({ ...draft, tickingClock })}
        />
        <p className="text-[10px] text-gray-500 italic">Themes are edited inline above — click a pill to rename, hover for ×, or use the dashed “+ Add theme” chip.</p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded bg-port-accent text-white text-sm font-medium disabled:opacity-50"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : null}
            Save arc
          </button>
          <button
            type="button"
            onClick={cancelEdit}
            disabled={saving}
            className="px-3 py-1.5 rounded text-sm text-gray-400 hover:text-white"
          >
            Cancel
          </button>
        </div>
      </fieldset>
    );
  }

  const shapeDef = arc.shape ? getStoryShape(arc.shape) : null;

  return (
    <div className="grid grid-cols-1 @2xl:grid-cols-[minmax(0,1fr)_260px] gap-4">
      <div className="space-y-2 min-w-0">
        {arc.seriesDesign ? (
          <details className="rounded border border-port-border p-2 text-xs text-gray-400">
            <summary className="cursor-pointer text-port-accent">Series design · {arc.seriesDesign.mode}</summary>
            <SeriesDesignEditor value={arc.seriesDesign} readOnly />
          </details>
        ) : null}
        {arc.logline ? (
          <div className="flex items-start gap-2">
            <p className="text-sm text-white flex-1 leading-relaxed">{arc.logline}</p>
            <FieldLockToggle series={series} field="logline" label="Logline" onSeriesUpdate={onSeriesUpdate} />
          </div>
        ) : null}
        {shapeDef ? (
          <div className="flex items-center gap-1.5">
            <span
              className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-port-bg border border-port-accent/40 text-port-accent"
              title={shapeDef.description}
            >
              <ArcShapeSparkline shape={shapeDef} width={48} height={16} />
              {shapeDef.label}
            </span>
            <FieldLockToggle series={series} field="shape" label="Shape" onSeriesUpdate={onSeriesUpdate} />
          </div>
        ) : null}
        <TickingClockCard clock={arc.tickingClock} series={series} onSeriesUpdate={onSeriesUpdate} />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {arc.summary ? (
            <details
              open={arcDetailsOpen}
              onToggle={(e) => setArcDetailsOpen(e.currentTarget.open)}
              className="text-xs text-gray-400 rounded border border-port-border bg-port-bg/50 px-2 py-1.5"
            >
              <summary className="cursor-pointer hover:text-white inline-flex items-center gap-1.5">
                Summary
                <FieldLockToggle series={series} field="summary" label="Summary" onSeriesUpdate={onSeriesUpdate} />
              </summary>
              <p className="mt-2 whitespace-pre-wrap max-h-36 overflow-y-auto pr-1">{arc.summary}</p>
            </details>
          ) : null}
          {arc.protagonistArc ? (
            <details
              open={arcDetailsOpen}
              onToggle={(e) => setArcDetailsOpen(e.currentTarget.open)}
              className="text-xs text-gray-400 rounded border border-port-border bg-port-bg/50 px-2 py-1.5"
            >
              <summary className="cursor-pointer hover:text-white inline-flex items-center gap-1.5">
                Protagonist arc
                <FieldLockToggle series={series} field="protagonistArc" label="Protagonist arc" onSeriesUpdate={onSeriesUpdate} />
              </summary>
              <p className="mt-2 whitespace-pre-wrap max-h-36 overflow-y-auto pr-1">{arc.protagonistArc}</p>
            </details>
          ) : null}
        </div>
        <button
          type="button"
          onClick={startEdit}
          disabled={locked}
          className="text-xs text-port-accent hover:underline"
        >
          {series.arc ? 'Edit arc' : 'Add series design'}
        </button>
      </div>
      <aside className="rounded border border-port-border bg-port-bg/60 p-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-[10px] uppercase tracking-wider text-gray-500">Themes</h3>
          {(arc.themes?.length ?? 0) > 0 ? (
            <FieldLockToggle series={series} field="themes" label="Themes" onSeriesUpdate={onSeriesUpdate} />
          ) : null}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <ThemeChips series={series} arc={arc} onSeriesUpdate={onSeriesUpdate} />
        </div>
      </aside>
    </div>
  );
}
