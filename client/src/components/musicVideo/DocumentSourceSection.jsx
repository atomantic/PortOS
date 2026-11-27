import { compactButtonClass as buttonCls, inputXsClass as inputCls } from './controlClasses.js';
import { musicVideoDocumentRenderer } from '../../../../server/lib/musicVideo/musicVideoMediaPolicy.js';
import { useEffect, useState, useRef, useId } from 'react';
import FilePickerButton from '../ui/FilePickerButton.jsx';
import { Download, FileArchive, FolderInput, LayoutTemplate, Unlink } from 'lucide-react';
import toast from '../ui/Toast';
import StageSection from './StageSection.jsx';
import { downloadBlob } from '../../lib/downloadBlob';
import { compositionDraft } from './compositionDraft.js';
import {
  detachMusicVideoCompositionDocument, getMusicVideoCompositionExport,
  importMusicVideoCompositionDirectory, importMusicVideoCompositionZip, startMusicVideoCompositionTemplate,
  upgradeMusicVideoCompositionEngine,
  updateMusicVideoProject,
} from '../../services/apiMusicVideo.js';

const SOURCE_LABELS = { template: 'template', zip: 'zip', directory: 'folder', generated: 'generated' };

export default function DocumentSourceSection({ project, doc, busy, run }) {
  const folderId = useId();
  // Replacing or detaching drops the current version folder once nothing
  // points at it, so both ask for a second click (no window.confirm).
  const [confirming, setConfirming] = useState(null);
  const confirmTimerRef = useRef(null);
  const [folder, setFolder] = useState('');
  const [template, setTemplate] = useState('layered');
  // Clear confirm state after 5 seconds or when the panel loses focus
  useEffect(() => {
    if (!confirming) {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      return;
    }
    confirmTimerRef.current = setTimeout(() => setConfirming(null), 5000);
    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    };
  }, [confirming]);

  const confirmFirst = (key, action) => () => {
    if (doc && confirming !== key) { setConfirming(key); return; }
    setConfirming(null);
    action();
  };
  const startTemplate = confirmFirst('template', () => run('template', () => startMusicVideoCompositionTemplate(project.id, template, { silent: true }), `${template === 'cel' ? 'Cel' : 'Layered'} template copied into this project`));
  const importZip = (file) => file && run('zip', () => importMusicVideoCompositionZip(project.id, file, { silent: true }), 'Composition document imported');
  const importFolder = () => folder.trim() && run('folder', () => importMusicVideoCompositionDirectory(project.id, folder.trim(), { silent: true }), 'Composition document imported');
  const exportZip = () => run('export', async () => {
    const buffer = await getMusicVideoCompositionExport(project.id, { silent: true });
    downloadBlob(buffer, `${(project.name || 'music-video').replace(/[^\w.-]+/g, '-')}-composition.zip`, 'application/zip');
    return {};
  });
  const detach = confirmFirst('detach', () => run('detach', () => detachMusicVideoCompositionDocument(project.id, { silent: true }), 'Composition document detached'));
  const upgradeEngine = async () => {
    const result = await run('engine', () => upgradeMusicVideoCompositionEngine(project.id, doc.directory, { silent: true }));
    if (result) toast.success(result.changed ? 'Layered engine updated; review the new render' : 'Layered engine is already current');
  };
  const docSummary = doc ? `${SOURCE_LABELS[doc.source?.kind] || 'imported'}${doc.source?.name ? ` · ${doc.source.name}` : ''}` : 'None yet';
  return (
    <StageSection id="mv-doc-source" title="Document source" summary={docSummary}>
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor="mv-doc-template" className="block text-xs text-port-text-muted mb-0.5">Template</label>
          <select id="mv-doc-template" value={template} disabled={!!busy} className={inputCls}
            onChange={(event) => { setTemplate(event.target.value); setConfirming(null); }}>
            <option value="layered">Layered — footage and stills</option>
            <option value="cel">Cel — drawn characters</option>
          </select>
        </div>
        <button type="button" className={buttonCls} disabled={!!busy} onClick={startTemplate}
          title={template === 'cel' ? 'Copy a drawn-character template with a posable figure, beat-locked walk and painted stage' : "Copy PortOS's layered template (scene media, camera moves, grain, HUD, kinetic lyrics) into this project"}>
          <LayoutTemplate size={14} /> {busy === 'template' ? 'Copying…' : confirming === 'template' ? 'Click again to replace' : doc ? 'Replace with template' : 'Start from template'}
        </button>
        <FilePickerButton accept=".zip,application/zip" onChange={(e) => importZip(e.target.files?.[0])} disabled={!!busy}
          ariaLabel="Import zip composition document" className={`${buttonCls} cursor-pointer`}
          title="A .zip whose root (or single top folder) holds index.html">
          <FileArchive size={14} aria-hidden="true" /> {busy === 'zip' ? 'Importing…' : 'Import zip'}
        </FilePickerButton>
        <div className="flex min-w-0 items-end gap-1">
          <div className="min-w-0 flex-1">
            <label htmlFor={folderId} className="block text-xs text-port-text-muted mb-0.5">Folder inside data/</label>
            <input id={folderId} type="text" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="compositions/my-video"
              className={`${inputCls} w-full sm:w-48`} />
          </div>
          <button type="button" className={buttonCls} disabled={!!busy || !folder.trim()} onClick={importFolder}>
            <FolderInput size={14} /> {busy === 'folder' ? 'Importing…' : 'Import folder'}
          </button>
        </div>
        <button type="button" className={buttonCls} disabled={!!busy || !doc} onClick={exportZip}>
          <Download size={14} /> Export zip
        </button>
        {doc && <button type="button" className={buttonCls}
          disabled={!!busy || !!project.composition?.documentDraft} onClick={upgradeEngine}>
          {busy === 'engine' ? 'Updating…' : 'Update layered engine'}
        </button>}
        <button type="button" className={buttonCls} disabled={!!busy || !doc} onClick={detach} title="Stop using this document (the render refuses until another is attached)">
          <Unlink size={14} /> {confirming === 'detach' ? 'Click again to detach' : 'Detach'}
        </button>
      </div>
      {doc && <p className="text-xs text-port-text-muted">Updating adds current layered effects in a new document version and makes earlier render reviews out of date. Custom and 3D engines are preserved.</p>}
      <label htmlFor="mv-doc-renderer" className="block text-xs text-port-text-muted">Authoring renderer</label>
      <select id="mv-doc-renderer" disabled={!!busy} value={musicVideoDocumentRenderer(project)} className={inputCls}
        onChange={(event) => run('renderer', () => updateMusicVideoProject(project.id, { composition: { ...compositionDraft(project), authoringRenderer: event.target.value } }, { silent: true }).then((project) => ({ project })), 'Renderer saved')}>
        <option value="three">Three.js authored worlds</option><option value="canvas">Canvas layered scenes</option>
      </select>
      <p className="text-xs text-port-text-muted">Three.js: modeled geometry, lighting, articulated characters and camera, with a local font overlay. Generated Three.js worlds use geometry only; selected images/video require Canvas or an imported document. Preview and export share deterministic seek(t), 1080p at 24 fps by default. Native Code mode remains the limited 720p Canvas renderer. Local ES modules and fonts are packaged; remote imports are blocked. Document motion blur is honored on export.</p>
    </StageSection>
  );
}
