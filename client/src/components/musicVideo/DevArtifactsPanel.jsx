import { useState } from 'react';
import { FileText, Film, Image as ImageIcon, LayoutGrid, Users, Upload, FolderOpen } from 'lucide-react';
import Pill from '../ui/Pill.jsx';
import FilePickerButton from '../ui/FilePickerButton.jsx';
import { timeAgo } from '../../utils/formatters.js';

export const DEV_ARTIFACT_KIND_LABELS = {
  'cast-sets': 'Cast & Sets',
  animatic: 'Animatic',
  treatment: 'Treatment',
  storyboard: 'Storyboard',
  other: 'Other',
};
const KIND_ICONS = { 'cast-sets': Users, animatic: Film, treatment: FileText, storyboard: LayoutGrid, other: ImageIcon };
export const DEV_ARTIFACT_STATUS = {
  pending: { label: 'Pending review', tone: 'warning' },
  approved: { label: 'Approved', tone: 'success' },
  'changes-requested': { label: 'Changes requested', tone: 'error' },
};
const ACCEPT = '.html,.htm,.md,.mp4,.png,.jpg,.jpeg';

/**
 * The project's development files ("ingredients") — the Cast & Sets sheet,
 * animatics, treatments, storyboards — with their review status. Opening one
 * navigates to its deep link (`/music-video/:projectId/:stage/dev/:artifactId`),
 * which shows it in the viewer drawer.
 *
 * `kinds` narrows the list to those artifact kinds (the Cast & Sets tab shows
 * only its own sheets); without `onUpload` the import control is left out.
 */
export default function DevArtifactsPanel({
  project, busy, onOpen, onUpload = null, kinds = null, title = 'Development',
  emptyText = 'Check-in sheets, animatics and other working files',
}) {
  const artifacts = (project.devArtifacts || [])
    .filter((a) => !a.deleted && (!kinds || kinds.includes(a.kind)))
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  const [kind, setKind] = useState('other');
  const idPrefix = `mv-dev-${project.id}`;

  const upload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return undefined;
    return onUpload(file, { kind, title: file.name.replace(/\.[^.]+$/, '') });
  };

  return (
    <section className="bg-port-card border border-port-border rounded-lg p-3 space-y-2 min-w-0" aria-labelledby={`${idPrefix}-title`}>
      <div className="flex flex-wrap items-center gap-2">
        <FolderOpen size={16} className="text-port-accent shrink-0" aria-hidden="true" />
        <h3 id={`${idPrefix}-title`} className="text-sm font-medium">{title}</h3>
        <span className="text-xs text-port-text-muted">{artifacts.length ? `${artifacts.length} file${artifacts.length === 1 ? '' : 's'}` : emptyText}</span>
        {onUpload && (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <label htmlFor={`${idPrefix}-kind`} className="sr-only">Kind of file to import</label>
            <select id={`${idPrefix}-kind`} value={kind} onChange={(e) => setKind(e.target.value)} disabled={busy}
              className="bg-port-bg border border-port-border rounded px-2 py-1 text-xs min-h-[44px] sm:min-h-0">
              {Object.entries(DEV_ARTIFACT_KIND_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
            <FilePickerButton accept={ACCEPT} onChange={upload} disabled={busy} ariaLabel="Import development file"
              className="flex items-center gap-1 text-sm text-port-accent min-h-[44px] sm:min-h-0 px-1 cursor-pointer">
              <Upload size={14} aria-hidden="true" /> Import
            </FilePickerButton>
          </div>
        )}
      </div>
      {artifacts.length > 0 && (
        <ul className="divide-y divide-port-border">
          {artifacts.map((artifact) => {
            const Icon = KIND_ICONS[artifact.kind] || ImageIcon;
            const status = DEV_ARTIFACT_STATUS[artifact.status] || DEV_ARTIFACT_STATUS.pending;
            const open = (artifact.notes || []).filter((n) => !n.resolvedAt).length;
            return (
              <li key={artifact.id}>
                <button type="button" onClick={() => onOpen(artifact.id)}
                  className="w-full flex flex-wrap items-center gap-2 py-2 text-left min-h-[44px] hover:bg-port-bg/60 rounded px-1">
                  <Icon size={15} className="text-port-text-muted shrink-0" aria-hidden="true" />
                  <span className="text-sm min-w-0 flex-1 truncate">{artifact.title}</span>
                  <span className="text-[11px] text-port-text-muted">{DEV_ARTIFACT_KIND_LABELS[artifact.kind] || artifact.kind} · v{artifact.version}</span>
                  {open > 0 && <Pill size="xs" tone="accent">{open} open note{open === 1 ? '' : 's'}</Pill>}
                  <Pill size="xs" tone={status.tone}>{status.label}</Pill>
                  <span className="text-[11px] text-port-text-muted hidden sm:inline">{timeAgo(artifact.updatedAt)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
