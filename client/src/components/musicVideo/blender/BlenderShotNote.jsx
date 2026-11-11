import { BLENDER_NOTE_MAX_LENGTH, BLENDER_NOTE_STATUSES } from '../../../lib/musicVideoBlender.js';
import { formatCount, timeAgo } from '../../../utils/formatters.js';
import { buttonCls, inputCls, labelCls, primaryCls } from './blenderStyles.js';

/**
 * The director's note on one shot: free text plus a status (to do, in
 * progress, ready for review, approved), saved only on Save. The unsaved
 * draft lives in the Blender hook, so it survives switching shot, tab or step.
 */
export default function BlenderShotNote({ blender, shotId }) {
  const saved = blender.state.notes?.[shotId] || {};
  const draft = blender.noteDrafts[shotId] || {};
  const text = draft.text ?? saved.text ?? '';
  const status = draft.status ?? saved.status ?? 'todo';
  const dirty = text !== (saved.text || '') || status !== (saved.status || 'todo');
  const saving = !!blender.pending[`note:${shotId}`];

  return (
    <div className="min-w-0 space-y-1.5">
      <div className="grid min-w-0 grid-cols-1 gap-2 @md:grid-cols-[minmax(0,1fr)_11rem]">
        <div className="min-w-0">
          <label htmlFor="mv-blender-note-text" className={labelCls}>Director note</label>
          <textarea id="mv-blender-note-text" rows={3} maxLength={BLENDER_NOTE_MAX_LENGTH} value={text} disabled={saving}
            onChange={(event) => blender.editNote(shotId, { text: event.target.value })}
            placeholder="What to change or keep in this shot"
            className="w-full min-w-0 rounded border border-port-border bg-port-bg p-2 text-sm focus:outline-none focus:ring-2 focus:ring-port-accent disabled:opacity-50" />
        </div>
        <div className="min-w-0">
          <label htmlFor="mv-blender-note-status" className={labelCls}>Status</label>
          <select id="mv-blender-note-status" value={status} disabled={saving}
            onChange={(event) => blender.editNote(shotId, { status: event.target.value })} className={inputCls}>
            {BLENDER_NOTE_STATUSES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-port-text-muted">
        <button type="button" className={primaryCls} disabled={!dirty || saving} onClick={() => blender.saveNote(shotId)}>
          {saving ? 'Saving…' : 'Save note'}
        </button>
        {dirty && !saving && <button type="button" className={buttonCls} onClick={() => blender.discardNote(shotId)}>Discard</button>}
        <span>{formatCount(text.length)} / {formatCount(BLENDER_NOTE_MAX_LENGTH)}</span>
        {dirty ? <span role="status" className="text-port-warning">Unsaved</span> : saved.updatedAt ? <span>Saved {timeAgo(saved.updatedAt)}</span> : null}
      </div>
    </div>
  );
}
