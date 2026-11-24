import { useState } from 'react';
import { useNavigate } from 'react-router';
import { createBlenderModel } from '../../services/apiBlenderModels.js';
import useAsyncAction from '../../hooks/useAsyncAction';
import { buttonCls, inputCls, labelCls, primaryCls } from '../musicVideo/blender/blenderStyles.js';
import BlenderModelReadiness from './BlenderModelReadiness.jsx';

/** Start a Blender model: a name and an optional one-line description. Opens the new model's page. */
export default function NewBlenderModelForm({ tool, onCancel }) {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [create, creating] = useAsyncAction(async () => {
    const model = await createBlenderModel({ name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}) }, { silent: true });
    navigate(`/3d/blender/${model.id}`);
  }, { errorMessage: 'Could not create the model' });

  return (
    <form aria-label="New Blender model" className="@container mb-6 min-w-0 space-y-3 rounded-xl border border-port-border bg-port-card p-4"
      onSubmit={(event) => { event.preventDefault(); if (name.trim() && !creating) create(); }}>
      <div>
        <h2 className="text-sm font-semibold">New Blender model</h2>
        <p className="text-xs text-port-text-muted">A model with separate, named parts, built from a Blender Python script you or a coding agent writes.</p>
      </div>
      <BlenderModelReadiness tool={tool} quiet />
      <div className="grid min-w-0 grid-cols-1 gap-2 @xl:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
        <div className="min-w-0">
          <label htmlFor="bm-new-name" className={labelCls}>Name</label>
          <input id="bm-new-name" value={name} maxLength={120} disabled={creating} onChange={(event) => setName(event.target.value)} className={inputCls} />
        </div>
        <div className="min-w-0">
          <label htmlFor="bm-new-description" className={labelCls}>Description (optional, one line)</label>
          <input id="bm-new-description" value={description} maxLength={300} disabled={creating} onChange={(event) => setDescription(event.target.value)} className={inputCls} />
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <button type="submit" className={primaryCls} disabled={!name.trim() || creating}>{creating ? 'Creating…' : 'Create model'}</button>
        <button type="button" className={buttonCls} disabled={creating} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
