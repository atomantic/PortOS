import { useState } from 'react';
import { CheckCircle2, RotateCcw, Trash2, ExternalLink, MessageSquarePlus } from 'lucide-react';
import Drawer from '../Drawer.jsx';
import Pill from '../ui/Pill.jsx';
import { musicVideoDevArtifactFileUrl } from '../../services/apiMusicVideo.js';
import { timeAgo } from '../../utils/formatters.js';
import { DEV_ARTIFACT_KIND_LABELS, DEV_ARTIFACT_STATUS } from './DevArtifactsPanel.jsx';

const buttonClass = 'flex items-center gap-1 rounded px-3 py-1.5 text-sm min-h-[44px] sm:min-h-0 disabled:opacity-50';

/** What a Cast & Sets note can point at: the sheet's images, or the direction as a whole. */
function castAndSetsTargets(stage) {
  const direction = stage?.direction || {};
  return [
    { id: '', label: 'General / direction' },
    { id: 'character', label: 'Character sheet' },
    { id: 'expressions', label: 'Expression sheet' },
    { id: 'looks', label: 'Looks' },
    ...(direction.sets || []).map((s) => ({ id: `set:${s.id}`, label: `Set: ${s.name}` })),
    ...Object.values(stage?.plan || {}).filter((p) => p.kind === 'test').map((p) => ({ id: p.key, label: `In-set test: ${p.label}` })),
  ];
}

function Viewer({ projectId, artifact, version }) {
  const entry = (artifact.versions || []).find((v) => v.version === version) || artifact;
  const url = musicVideoDevArtifactFileUrl(projectId, artifact.id, version === artifact.version ? null : version);
  const title = `${artifact.title} v${entry.version || version}`;
  if (entry.mimeType?.startsWith('image/')) return <img src={url} alt={title} className="w-full h-auto rounded border border-port-border" />;
  if (entry.mimeType?.startsWith('video/')) return <video src={url} controls className="w-full rounded border border-port-border" aria-label={title} />;
  // HTML and Markdown: an opaque-origin frame (no allow-same-origin), so a
  // sheet's own script can run but can never reach PortOS. The server's CSP
  // enforces the same sandbox and blocks every network fetch.
  return (
    <iframe
      key={url}
      src={url}
      title={title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      className="w-full h-[60vh] lg:h-[calc(100vh-9rem)] rounded border border-port-border bg-white"
    />
  );
}

/**
 * One development artifact, full width: the file (sandboxed), its version
 * history, notes and review actions. For the sheet the Cast & Sets check-in is
 * waiting on, the review actions are the stage's own: "Regenerate with notes"
 * and "Approve & continue". Open state and the viewed version live in the URL
 * (`/music-video/:projectId/dev/:artifactId?v=N`).
 */
export default function DevArtifactDrawer({
  open, onClose, project, artifact, version, onVersionChange, ops, busy, castAndSets,
}) {
  const [noteText, setNoteText] = useState('');
  const [noteTarget, setNoteTarget] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  if (!open) return null;
  if (!artifact) {
    return (
      <Drawer open onClose={onClose} title="Development file" subtitle={project?.name} size="sm" closeLabel="Close development file">
        <p className="text-sm text-port-text-muted">This file was not found — it may have been deleted.</p>
      </Drawer>
    );
  }
  const stage = project?.castAndSets || null;
  const isStageSheet = stage?.artifactId === artifact.id;
  const stageWorking = isStageSheet && ['directing', 'imaging', 'assembling'].includes(stage.status);
  const shown = (artifact.versions || []).some((v) => v.version === version) ? version : artifact.version;
  const openNotes = (artifact.notes || []).filter((n) => !n.resolvedAt);
  const status = DEV_ARTIFACT_STATUS[artifact.status] || DEV_ARTIFACT_STATUS.pending;
  const targets = isStageSheet ? castAndSetsTargets(stage) : null;
  const idPrefix = `mv-dev-${artifact.id}`;

  const addNote = () => {
    const text = noteText.trim();
    if (!text) return;
    ops.addNote(artifact.id, { text, ...(noteTarget ? { target: noteTarget } : {}) })
      .then((res) => { if (res) setNoteText(''); });
  };

  return (
    <Drawer open onClose={onClose} title={artifact.title} subtitle={`${DEV_ARTIFACT_KIND_LABELS[artifact.kind] || artifact.kind} · ${project?.name || ''}`}
      widthClass="sm:w-[96vw] 2xl:w-[1600px]" closeLabel="Close development file" closeOnEsc={!noteText}>
      <div className="flex flex-col lg:flex-row gap-4 min-w-0">
        <div className="flex-1 min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Pill size="xs" tone={status.tone}>{status.label}</Pill>
            <label htmlFor={`${idPrefix}-version`} className="text-port-text-muted">Version</label>
            <select id={`${idPrefix}-version`} value={shown} onChange={(e) => onVersionChange(Number(e.target.value))}
              className="bg-port-bg border border-port-border rounded px-2 py-1 min-h-[44px] sm:min-h-0">
              {[...(artifact.versions || [])].reverse().map((v) => (
                <option key={v.version} value={v.version}>v{v.version}{v.version === artifact.version ? ' (current)' : ''} · {timeAgo(v.createdAt)}</option>
              ))}
            </select>
            <a href={musicVideoDevArtifactFileUrl(project.id, artifact.id, shown === artifact.version ? null : shown)} target="_blank" rel="noreferrer noopener"
              className="flex items-center gap-1 text-port-accent min-h-[44px] sm:min-h-0">
              <ExternalLink size={12} aria-hidden="true" /> Open in a tab
            </a>
          </div>
          <Viewer projectId={project.id} artifact={artifact} version={shown} />
        </div>

        <aside className="lg:w-80 shrink-0 space-y-3 min-w-0" aria-label="Review">
          {isStageSheet && (
            <p className="text-xs text-port-text-muted" role="status">
              {stage.status === 'review' && 'The autopilot is waiting for your check-in.'}
              {stageWorking && 'Regenerating — the new version appears here when it is ready.'}
              {stage.status === 'approved' && 'Approved — these references condition the storyboard frames.'}
              {stage.status === 'failed' && `The check-in stopped: ${stage.stopReason || 'unknown error'}`}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {isStageSheet ? (
              <>
                <button type="button" disabled={busy || stageWorking || openNotes.length === 0} onClick={() => castAndSets.regenerate()}
                  title={openNotes.length ? 'Re-render only what your open notes touch, as a new version' : 'Add a note first'}
                  className={`${buttonClass} border border-port-border`}>
                  <RotateCcw size={14} aria-hidden="true" /> Regenerate with notes
                </button>
                {stage.status === 'review' && (
                  <button type="button" disabled={busy} onClick={() => castAndSets.approveAndContinue()} className={`${buttonClass} bg-port-accent text-white`}>
                    <CheckCircle2 size={14} aria-hidden="true" /> Approve &amp; continue
                  </button>
                )}
              </>
            ) : (
              <>
                <button type="button" disabled={busy || artifact.status === 'approved'} onClick={() => ops.review(artifact.id, { status: 'approved' })}
                  className={`${buttonClass} bg-port-accent text-white`}>
                  <CheckCircle2 size={14} aria-hidden="true" /> Approve
                </button>
                <button type="button" disabled={busy}
                  onClick={() => ops.review(artifact.id, { status: 'changes-requested', ...(noteText.trim() ? { note: noteText.trim() } : {}) }).then((res) => { if (res) setNoteText(''); })}
                  className={`${buttonClass} border border-port-border`}>
                  Request changes
                </button>
              </>
            )}
          </div>

          <div className="space-y-1.5">
            <label htmlFor={`${idPrefix}-note`} className="block text-xs text-port-text-muted">Note</label>
            {targets && (
              <>
                <label htmlFor={`${idPrefix}-target`} className="sr-only">Note is about</label>
                <select id={`${idPrefix}-target`} value={noteTarget} onChange={(e) => setNoteTarget(e.target.value)}
                  className="w-full bg-port-bg border border-port-border rounded px-2 py-1 text-xs min-h-[44px] sm:min-h-0">
                  {targets.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                </select>
              </>
            )}
            <textarea id={`${idPrefix}-note`} rows={3} maxLength={2000} value={noteText} onChange={(e) => setNoteText(e.target.value)}
              placeholder={targets ? 'What should change? e.g. a different jacket, a wider shot of the set' : 'What should change?'}
              className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm" />
            <button type="button" disabled={busy || !noteText.trim()} onClick={addNote} className={`${buttonClass} border border-port-border`}>
              <MessageSquarePlus size={14} aria-hidden="true" /> Add note
            </button>
          </div>

          <div>
            <h3 className="text-xs uppercase tracking-wide text-port-text-muted mb-1">Notes</h3>
            {(artifact.notes || []).length === 0 && <p className="text-xs text-port-text-muted">No notes yet.</p>}
            <ul className="space-y-1.5">
              {[...(artifact.notes || [])].reverse().map((note) => (
                <li key={note.id} className={`text-xs rounded border border-port-border p-2 ${note.resolvedAt ? 'opacity-60' : ''}`}>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {note.target && <Pill size="xs" tone="accent">{note.target}</Pill>}
                    <span className="text-port-text-muted">v{note.version} · {timeAgo(note.createdAt)}</span>
                    <input id={`${idPrefix}-resolved-${note.id}`} type="checkbox" className="ml-auto" checked={!!note.resolvedAt} disabled={busy}
                      onChange={(e) => ops.resolveNote(artifact.id, note.id, e.target.checked)} />
                    <label htmlFor={`${idPrefix}-resolved-${note.id}`} className="min-h-[44px] sm:min-h-0 flex items-center">Resolved</label>
                  </div>
                  <p className="mt-1 break-words">{note.text}</p>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h3 className="text-xs uppercase tracking-wide text-port-text-muted mb-1">Versions</h3>
            <ol className="space-y-1 text-xs">
              {[...(artifact.versions || [])].reverse().map((v) => (
                <li key={v.version}>
                  <button type="button" onClick={() => onVersionChange(v.version)}
                    className={`min-h-[44px] sm:min-h-0 ${v.version === shown ? 'text-port-accent' : 'text-port-text'}`}>
                    v{v.version} · {v.source === 'cast-and-sets' ? 'generated' : v.source} · {timeAgo(v.createdAt)}
                  </button>
                </li>
              ))}
            </ol>
          </div>

          <div className="pt-2 border-t border-port-border">
            {confirmDelete ? (
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span>Remove this file from the project?</span>
                <button type="button" disabled={busy} onClick={() => ops.remove(artifact.id).then((res) => { if (res) onClose(); })} className="text-port-error min-h-[44px] sm:min-h-0 px-1">Remove</button>
                <button type="button" onClick={() => setConfirmDelete(false)} className="min-h-[44px] sm:min-h-0 px-1">Cancel</button>
              </div>
            ) : (
              <button type="button" onClick={() => setConfirmDelete(true)} disabled={busy} className="flex items-center gap-1 text-xs text-port-error min-h-[44px] sm:min-h-0">
                <Trash2 size={12} aria-hidden="true" /> Remove
              </button>
            )}
          </div>
        </aside>
      </div>
    </Drawer>
  );
}
