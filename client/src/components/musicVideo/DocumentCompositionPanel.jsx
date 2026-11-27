import { useState } from 'react';
import toast from '../ui/Toast';
import { formatBytes, timeAgo } from '../../utils/formatters.js';
import { getMusicVideoCompositionDocument } from '../../services/apiMusicVideo.js';
import DocumentSourceSection from './DocumentSourceSection.jsx';
import DocumentGenerateSection from './DocumentGenerateSection.jsx';
import OverlayEditor from './OverlayEditor.jsx';
import { pluralize } from '../../lib/textUtils';

/** The document's files, read when opened (the manifest route). */
function DocumentFiles({ projectId, directory }) {
  const [manifest, setManifest] = useState(null);
  const [error, setError] = useState('');
  const load = (open) => {
    if (!open || manifest) return;
    setError('');
    getMusicVideoCompositionDocument(projectId, { silent: true })
      .then(setManifest)
      .catch((err) => setError(err?.message || 'Could not list the document files'));
  };
  return (
    <details key={directory} className="rounded border border-port-border p-2 text-xs" onToggle={(e) => load(e.currentTarget.open)}>
      <summary className="cursor-pointer select-none text-port-text-muted min-h-[44px] pointer-fine:sm:min-h-0 flex items-center">Files</summary>
      {error && <p role="status" className="mt-1 text-port-error">{error}</p>}
      {manifest && !manifest.available && <p className="mt-1 text-port-warning">The document folder is missing on this machine — import it again.</p>}
      {manifest?.available && (
        <ul className="mt-1 max-h-48 overflow-y-auto font-mono">
          {manifest.files.map((file) => <li key={file.path} className="flex justify-between gap-2"><span className="min-w-0 break-all">{file.path}</span><span className="shrink-0 text-port-text-muted">{formatBytes(file.bytes)}</span></li>)}
        </ul>
      )}
    </details>
  );
}

/**
 * The project's composition document (render style `document`): what is
 * attached, import (template / zip / data folder), export, the HUD overlay and
 * the document's files. The live preview is `CompositionPreviewPlayer`, docked
 * beside the stage tabs so it stays visible while scenes and typography are
 * edited.
 */
export default function DocumentCompositionPanel({ project, audioUrl, onProject, onSave }) {
  const doc = project.composition?.document || null;
  const [busy, setBusy] = useState(null);
  const run = async (label, task, success) => {
    setBusy(label);
    const result = await Promise.resolve().then(task).catch((err) => { toast.error(err?.message || 'Composition document action failed'); return null; });
    setBusy(null);
    if (result?.project) onProject(result.project);
    if (result && success) toast.success(success);
    return result;
  };

  return (
    <section className="mt-3 space-y-2 rounded-lg border border-port-border bg-port-bg p-2" aria-label="Composition document">
      <div className="flex items-center gap-2 text-sm text-port-text">
        <span>Composition document</span>
        {doc && <span className="text-xs text-port-text-muted">
          {doc.files != null && pluralize(doc.files, 'file')}
          {doc.bytes != null && ` · ${formatBytes(doc.bytes)}`}
          {doc.updatedAt && ` · updated ${timeAgo(doc.updatedAt)}`}
        </span>}
      </div>
      <DocumentSourceSection project={project} doc={doc} busy={busy} run={run} />
      <DocumentGenerateSection project={project} doc={doc} busy={busy} run={run} audioUrl={audioUrl} />

      <OverlayEditor key={`${project.id}-${project.composition?.overlay ? 'hud' : 'none'}`} project={project} onSave={onSave} />
      {doc && <DocumentFiles key={doc.directory} projectId={project.id} directory={doc.directory} />}
    </section>
  );
}
