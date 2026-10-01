import { useEffect, useState } from 'react';

const inputClass = 'w-full rounded border border-port-border bg-port-bg px-3 py-2 text-sm';
const budgets = { iterations: 8, timeSeconds: 900, tokens: 128000, renderSeconds: 300, diskBytes: 512 * 1024 * 1024 };
const emptyManifest = {
  title: '', brief: { concept: '', cast: '', onScreenText: '' }, styleGuide: '',
  renderer: { kind: 'browser', version: 'code-animation-html-v1', engine: null },
  format: { width: 1920, height: 1080, fps: 30, durationSeconds: 20 }, seed: null,
  entrypoints: [{ role: 'preview', path: 'index.html' }], assets: [], shots: [], events: [],
  audio: { kind: 'silence' }, execution: { requested: null, effective: null },
};

export default function ProductionProjectForm({ project, onSave, busy, onDirtyChange }) {
  const [manifest, setManifest] = useState(() => project?.manifest || emptyManifest);
  const [limits, setLimits] = useState(() => project?.budgets || budgets);
  const [baseline, setBaseline] = useState(() => JSON.stringify({ manifest: project?.manifest || emptyManifest, budgets: project?.budgets || budgets }));
  const dirty = JSON.stringify({ manifest, budgets: limits }) !== baseline;
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  const field = (name, label, value, change, type = 'text', props = {}) => (
    <div key={name} className="min-w-0">
      <label htmlFor={`cap-${name}`} className="mb-1 block text-xs text-gray-400">{label}</label>
      <input id={`cap-${name}`} type={type} value={value ?? ''} onChange={event => change(type === 'number' ? Number(event.target.value) : event.target.value)} className={inputClass} {...props} />
    </div>
  );
  return <form className="space-y-3" onSubmit={event => {
    event.preventDefault();
    onSave({ manifest, budgets: limits }).then(saved => {
      if (saved) {
        setManifest(saved.manifest);
        setLimits(saved.budgets);
        setBaseline(JSON.stringify({ manifest: saved.manifest, budgets: saved.budgets }));
      }
    });
  }}>
    <fieldset disabled={busy} className="min-w-0 space-y-3">
      {field('title', 'Title', manifest.title, title => setManifest(previous => ({ ...previous, title })), 'text', { maxLength: 200 })}
      <div>
        <label htmlFor="cap-concept" className="mb-1 block text-xs text-gray-400">Film brief</label>
        <textarea id="cap-concept" rows={3} maxLength={6000} value={manifest.brief.concept} onChange={event => setManifest(previous => ({ ...previous, brief: { ...previous.brief, concept: event.target.value } }))} className={inputClass} />
      </div>
      <div>
        <label htmlFor="cap-style" className="mb-1 block text-xs text-gray-400">Style and reference intent</label>
        <textarea id="cap-style" rows={2} maxLength={16000} value={manifest.styleGuide} onChange={event => setManifest(previous => ({ ...previous, styleGuide: event.target.value }))} className={inputClass} />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="cap-renderer" className="mb-1 block text-xs text-gray-400">Renderer</label>
          <select id="cap-renderer" className={inputClass} value={manifest.renderer.kind} onChange={event => setManifest(previous => ({ ...previous, renderer: { ...previous.renderer, kind: event.target.value } }))}>
            <option value="browser">Browser</option><option value="blender">Blender</option>
          </select>
        </div>
        {field('version', 'Renderer version', manifest.renderer.version, version => setManifest(previous => ({ ...previous, renderer: { ...previous.renderer, version } })), 'text', { required: true, maxLength: 128 })}
        {Object.entries({ width: 'Width (pixels)', height: 'Height (pixels)', fps: 'Frames per second', durationSeconds: 'Duration (seconds)' }).map(([name, label]) =>
          field(name, label, manifest.format[name], value => setManifest(previous => ({ ...previous, format: { ...previous.format, [name]: value } })), 'number', { required: true, min: name === 'width' || name === 'height' ? 2 : 1, step: name === 'width' || name === 'height' ? 2 : 1 }))}
        <div>
          <label htmlFor="cap-seed" className="mb-1 block text-xs text-gray-400">Deterministic seed (optional)</label>
          <input id="cap-seed" type="number" min={0} max={4294967295} step={1} value={manifest.seed ?? ''} className={inputClass} onChange={event => setManifest(previous => ({ ...previous, seed: event.target.value === '' ? null : Number(event.target.value) }))} />
        </div>
        <div>
          <label htmlFor="cap-audio" className="mb-1 block text-xs text-gray-400">Soundtrack policy</label>
          <select id="cap-audio" value={manifest.audio.kind} className={inputClass} onChange={event => setManifest(previous => ({ ...previous, audio: event.target.value === 'silence' ? { kind: 'silence' } : { kind: event.target.value, notes: '' } }))}>
            <option value="silence">Intentional silence</option><option value="procedural">Procedural sound</option><option value="external">External soundtrack</option>
            {manifest.audio.kind === 'file' && <option value="file">Packaged audio file</option>}
          </select>
        </div>
      </div>
      <h3 className="text-sm font-medium">Independent budgets</h3>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {Object.entries({ iterations: 'Iterations', timeSeconds: 'Elapsed time (seconds)', tokens: 'Tokens', renderSeconds: 'Render time (seconds)', diskBytes: 'Retained source disk (bytes)' }).map(([name, label]) =>
          field(name, label, limits[name], value => setLimits(previous => ({ ...previous, [name]: value })), 'number', { required: true, min: 1, step: 1 }))}
      </div>
      <button type="submit" className="rounded bg-port-accent px-3 py-2 text-sm text-white disabled:opacity-50">{busy ? 'Saving…' : project ? 'Save project settings' : 'Create Production project'}</button>
    </fieldset>
  </form>;
}
