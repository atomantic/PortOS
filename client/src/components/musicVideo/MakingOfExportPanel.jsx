import { useEffect, useRef, useState } from 'react';
import { getMusicVideoMakingOfCatalog, listMusicVideoProjectSummaries, previewMusicVideoMakingOf, exportMusicVideoMakingOf } from '../../services/apiMusicVideo.js';
import { downloadBlob } from '../../lib/downloadBlob.js';
import { useAsyncAction } from '../../hooks/useAsyncAction.js';
import { formatBytes, formatCount } from '../../utils/formatters.js';

/** Transient export selections; project navigation remains owned by the URL. */
export default function MakingOfExportPanel({ project }) {
  const [catalogs, setCatalogs] = useState([]);
  const [options, setOptions] = useState([]);
  const [projectCursor, setProjectCursor] = useState(null);
  const [nextProject, setNextProject] = useState('');
  const [picks, setPicks] = useState({});
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const selection = { projects: catalogs.map(catalog => ({ projectId: catalog.project.id, snapshot: catalog.snapshot,
    assets: catalog.assets.filter(asset => picks[`${catalog.project.id}:${asset.id}`]).map(asset => ({ id: asset.id, ...picks[`${catalog.project.id}:${asset.id}`] })) })) };

  useEffect(() => {
    let active = true;
    generation.current += 1;
    setCatalogs([]); setPicks({}); setPreview(null); setError('');
    Promise.all([getMusicVideoMakingOfCatalog(project.id, { silent: true }), listMusicVideoProjectSummaries({ limit: 100 }, { silent: true })])
      .then(([catalog, summaries]) => { if (active) { setCatalogs([catalog]); setOptions(summaries.items); setProjectCursor(summaries.nextCursor ?? null); } })
      .catch(err => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [project.id, project.updatedAt]);

  const [loadMore, loadingMore] = useAsyncAction(async () => {
    const runGeneration = generation.current;
    const summaries = await listMusicVideoProjectSummaries({ cursor: projectCursor, limit: 100 }, { silent: true });
    if (runGeneration !== generation.current) return;
    setOptions(current => [...current, ...summaries.items.filter(item => !current.some(existing => existing.id === item.id))]);
    setProjectCursor(summaries.nextCursor ?? null);
  });

  const [addProject, adding] = useAsyncAction(async () => {
    const runGeneration = generation.current;
    const catalog = await getMusicVideoMakingOfCatalog(nextProject, { silent: true });
    if (runGeneration !== generation.current) return;
    setCatalogs(current => current.some(item => item.project.id === catalog.project.id) ? current : [...current, catalog]);
    setNextProject(''); setPreview(null);
  });
  const [inspect, inspecting] = useAsyncAction(async () => {
    const runGeneration = generation.current;
    setPreview(null);
    const refreshed = await Promise.all(catalogs.map(catalog => getMusicVideoMakingOfCatalog(catalog.project.id, { silent: true })));
    if (runGeneration !== generation.current) return;
    setCatalogs(refreshed);
    const freshSelection = { projects: selection.projects.map((selected, index) => ({ ...selected, snapshot: refreshed[index].snapshot })) };
    if (freshSelection.projects.some((selected, index) => selected.assets.some(asset => !refreshed[index].assets.some(item => item.id === asset.id)))) {
      throw new Error('A selected artifact was removed. Review the refreshed catalog and preview again.');
    }
    const result = await previewMusicVideoMakingOf(freshSelection, { silent: true });
    if (runGeneration === generation.current) setPreview({ ...result, selection: freshSelection });
  });
  const [download, downloading] = useAsyncAction(async () => {
    const buffer = await exportMusicVideoMakingOf({ ...preview.selection, previewDigest: preview.previewDigest }, { silent: true });
    downloadBlob(buffer, 'music-video-making-of.zip', 'application/zip');
  });
  const busy = adding || inspecting || downloading || loadingMore;
  const changePick = (key, value) => { setPicks(current => ({ ...current, [key]: value })); setPreview(null); };

  return <section aria-label="Making-of export" className="min-w-0 rounded-lg border border-port-border bg-port-card p-3 space-y-3">
    <h3 className="text-sm font-medium">Making-of export</h3>
    <p className="text-xs text-port-text-muted">Compile blueprint and video versions into a portable planning ZIP. Select exact files, inspect the inventory, then download. GitHub publication is a separate step.</p>
    {error && <p role="alert" className="text-sm text-port-error">{error}</p>}
    <div className="flex flex-wrap items-end gap-2">
      <div className="min-w-0 max-w-full">
        <label htmlFor="making-of-project" className="block text-xs">Add another version or project</label>
        <select id="making-of-project" className="max-w-full rounded border border-port-border bg-port-bg p-2 text-sm" value={nextProject} disabled={busy} onChange={e => setNextProject(e.target.value)}>
          <option value="">Choose a project</option>
          {options.filter(item => !catalogs.some(catalog => catalog.project.id === item.id)).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </div>
      <button type="button" disabled={!nextProject || busy || catalogs.length >= 8} onClick={addProject} className="rounded border border-port-border p-2 text-sm">Add to package</button>
      {projectCursor != null && <button type="button" disabled={busy} onClick={loadMore} className="rounded border border-port-border p-2 text-sm">Load more projects</button>}
    </div>
    {catalogs.map(catalog => <fieldset key={catalog.project.id} disabled={busy} className="min-w-0 border border-port-border rounded p-2 space-y-2">
      <legend className="text-sm px-1">{catalog.project.name} · v{catalog.project.version}</legend>
      <p className="text-xs text-port-text-muted">Planning JSON, cast/set sheet, storyboard and shot JSON/CSV are included. No image files are selected by default.</p>
      {catalog.project.id !== project.id && <button type="button" className="text-xs text-port-accent" onClick={() => { setCatalogs(current => current.filter(item => item !== catalog)); setPreview(null); }}>Remove project</button>}
      {!catalog.assets.length && <p className="text-xs">No artifact or image files available. Missing sheets remain visible in the inventory.</p>}
      {catalog.assets.map((asset, index) => {
        const key = `${catalog.project.id}:${asset.id}`;
        const pick = picks[key];
        const inputId = `making-of-${catalog.project.id}-${index}`;
        return <div key={asset.id} className="min-w-0 space-y-1 border-t border-port-border pt-2">
          <div className="flex gap-2 items-start">
            <input id={inputId} type="checkbox" checked={!!pick} disabled={!['included', 'partial', 'requires-ownership', 'requires-owner-project'].includes(asset.status)} onChange={e => changePick(key, e.target.checked ? { rights: 'unknown', attribution: '', ownershipConfirmed: false } : null)} />
            <label htmlFor={inputId} className="break-words text-xs min-w-0">{asset.label} — {asset.status === 'included' ? `available, ${formatBytes(asset.bytes)}` : `${asset.status}: ${asset.reason}`}{asset.visualCount ? ` · ${formatCount(asset.visualCount)} graphics` : ''}</label>
          </div>
          {pick && <div className="flex flex-wrap gap-2 pl-5">
            <div><label htmlFor={`${inputId}-rights`} className="block text-xs">Rights declaration</label>
              <select id={`${inputId}-rights`} value={pick.rights} onChange={e => changePick(key, { ...pick, rights: e.target.value })} className="rounded border border-port-border bg-port-bg p-1 text-xs">
                <option value="unknown">Unverified</option><option value="owned">Owned</option><option value="licensed">Licensed</option>
              </select></div>
            <div className="min-w-0"><label htmlFor={`${inputId}-credit`} className="block text-xs">Attribution / license note</label>
              <input id={`${inputId}-credit`} value={pick.attribution} maxLength={2000} onChange={e => changePick(key, { ...pick, attribution: e.target.value })} className="rounded border border-port-border bg-port-bg p-1 text-xs max-w-full" /></div>
            {asset.ownershipDeclarationAvailable && <div className="flex gap-2 items-start w-full">
              <input id={`${inputId}-owned`} type="checkbox" checked={pick.ownershipConfirmed || false} disabled={pick.rights !== 'owned'} onChange={e => changePick(key, { ...pick, ownershipConfirmed: e.target.checked })} />
              <label htmlFor={`${inputId}-owned`} className="text-xs">I own this file and its embedded raster graphics. This records my declaration; it does not verify publication clearance. Choose Owned to confirm.</label>
            </div>}
          </div>}
        </div>;
      })}
    </fieldset>)}
    <div className="flex flex-wrap gap-2">
      <button type="button" onClick={inspect} disabled={busy || !catalogs.length} className="rounded border border-port-border p-2 text-sm">{inspecting ? 'Compiling preview…' : 'Preview inventory'}</button>
      <button type="button" onClick={download} disabled={busy || !preview} className="rounded bg-port-accent text-port-bg p-2 text-sm">{downloading ? 'Downloading…' : 'Download planning ZIP'}</button>
    </div>
    {preview && <div className="space-y-2 text-xs min-w-0" aria-label="Package inventory">
      <p>{formatCount(preview.files.length)} files · {formatBytes(preview.bytes)} · Rights require review before sharing.</p>
      <ul className="space-y-1">{preview.manifest.inventory.map(item => <li key={`${item.projectId}:${item.id}`} className="break-words">
        {item.label || item.id}: {item.status}{item.reason ? ` (${item.reason})` : ''} · rights: {item.rights || 'unknown'}
        {item.transformation && ` · ${item.transformation}`}
      </li>)}</ul>
      <details><summary>Package files and checksums</summary><ul>{preview.files.map(file => <li key={file.path} className="break-all">{file.path} · {formatBytes(file.bytes)} · SHA-256 {file.sha256}</li>)}</ul></details>
    </div>}
  </section>;
}
