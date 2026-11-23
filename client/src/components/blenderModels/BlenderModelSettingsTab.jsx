import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Trash2 } from 'lucide-react';
import InlineConfirmRow from '../ui/InlineConfirmRow';
import useAsyncAction from '../../hooks/useAsyncAction';
import { deleteBlenderModel } from '../../services/apiBlenderModels.js';
import { copyToClipboard } from '../../lib/clipboard.js';
import { buttonCls, inputCls, labelCls, primaryCls } from '../musicVideo/blender/blenderStyles.js';
import BlenderModelReadiness from './BlenderModelReadiness.jsx';

/** Blender readiness, where the source lives, the name and description, and deleting the model. */
export default function BlenderModelSettingsTab({ model }) {
  const { state, pending } = model;
  const navigate = useNavigate();
  // null until edited, so a change made elsewhere shows while nothing is being typed.
  const [name, setName] = useState(null);
  const [description, setDescription] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [remove, removing] = useAsyncAction(async () => {
    await deleteBlenderModel(state.id, { silent: true });
    navigate('/3d');
  }, { errorMessage: 'Could not delete the model' });
  const saved = { name: state.name, description: state.description || '' };
  const shown = { name: name ?? saved.name, description: description ?? saved.description };
  const patch = Object.fromEntries(Object.entries(shown).map(([key, value]) => [key, value.trim()]).filter(([key, value]) => value !== saved[key]));
  const dirty = Object.keys(patch).length > 0;
  const save = async () => {
    const result = await model.update(patch);
    if (!result.ok) return;
    setName(null);
    setDescription(null);
  };

  return (
    <div className="@container min-w-0 space-y-4">
      <section aria-label="Blender readiness" className="space-y-1.5">
        <h2 className="text-sm font-medium">Blender</h2>
        <BlenderModelReadiness tool={state.tool} />
      </section>
      <section aria-label="Workspace" className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
        <h2 className="w-full text-sm font-medium">Workspace</h2>
        <code className="min-w-0 break-all font-mono">{state.workspace.path}</code>
        <button type="button" className={buttonCls} onClick={() => copyToClipboard(state.workspace.path, 'Workspace path copied')}>Copy path</button>
      </section>
      <form aria-label="Model details" className="min-w-0 space-y-2 border-t border-port-border pt-3"
        onSubmit={(event) => { event.preventDefault(); if (dirty && shown.name.trim() && !pending.update) save(); }}>
        <div className="grid min-w-0 grid-cols-1 gap-2 @xl:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
          <div className="min-w-0">
            <label htmlFor="bm-name" className={labelCls}>Name</label>
            <input id="bm-name" value={shown.name} maxLength={120} disabled={!!pending.update} onChange={(event) => setName(event.target.value)} className={inputCls} />
          </div>
          <div className="min-w-0">
            <label htmlFor="bm-description" className={labelCls}>Description (one line)</label>
            <input id="bm-description" value={shown.description} maxLength={300} disabled={!!pending.update} onChange={(event) => setDescription(event.target.value)} className={inputCls} />
          </div>
        </div>
        <button type="submit" className={primaryCls} disabled={!dirty || !shown.name.trim() || !!pending.update}>{pending.update ? 'Saving…' : 'Save'}</button>
      </form>
      <section aria-label="Delete model" className="min-w-0 space-y-2 border-t border-port-border pt-3">
        <button type="button" className={buttonCls} disabled={confirming || removing} onClick={() => setConfirming(true)}>
          <Trash2 size={14} aria-hidden="true" /> {removing ? 'Deleting…' : 'Delete model'}
        </button>
        {confirming && (
          <InlineConfirmRow autoFocus aria-label={`Confirm deleting ${state.name}`}
            question={`Delete "${state.name}"? Its builds are removed; the files under src/ stay on disk.`}
            onConfirm={() => { setConfirming(false); remove(); }} onCancel={() => setConfirming(false)} />
        )}
      </section>
    </div>
  );
}
