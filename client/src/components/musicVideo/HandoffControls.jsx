import { useState } from 'react';
import { Download, FileArchive, Upload, Activity } from 'lucide-react';
import FilePickerButton from '../ui/FilePickerButton';

const PROVIDERS = [['midjourney', 'Midjourney'], ['external', 'Other tool']];
const HANDOFF_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,video/mp4,video/quicktime,video/webm';

/**
 * External-asset handoff (#8965) for tools PortOS does not drive, such as
 * Midjourney: export a manifest of per-scene prompts, file tags and reference
 * files; generate by hand; then import the downloads. Files whose names keep a
 * scene's tag (e.g. `S03-1a2b3c4d`) land on that exact scene as imported takes
 * with the chosen provider recorded. PortOS never contacts the external tool.
 */
export default function HandoffControls({ projectId, busy, onExport, onExportBundle, onImport }) {
  const [provider, setProvider] = useState('midjourney');
  const selectId = `mv-handoff-provider-${projectId}`;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
      <span className="text-port-text-muted">External handoff</span>
      <label htmlFor={selectId} className="sr-only">Handoff provider</label>
      <select id={selectId} value={provider} onChange={(e) => setProvider(e.target.value)}
        className="bg-port-bg border border-port-border rounded px-2 py-1 text-xs min-h-[44px] sm:min-h-0">
        {PROVIDERS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      <button type="button" onClick={onExport} disabled={busy}
        className="flex items-center gap-1 bg-port-border hover:bg-port-border/70 disabled:opacity-50 rounded px-2 py-1 min-h-[44px] sm:min-h-0"
        title="Download per-scene prompts, file tags and reference files as JSON">
        <Download size={13} /> Export prompts
      </button>
      {onExportBundle && (
        <button type="button" onClick={onExportBundle} disabled={busy}
          className="flex items-center gap-1 bg-port-border hover:bg-port-border/70 disabled:opacity-50 rounded px-2 py-1 min-h-[44px] sm:min-h-0"
          title="Download the manifest plus every reference image and selected frame as one zip">
          <FileArchive size={13} /> Export bundle
        </button>
      )}
      <FilePickerButton multiple accept={HANDOFF_ACCEPT} disabled={busy}
        onChange={(e) => onImport(Array.from(e.target.files || []), provider)}
        ariaLabel="Import generated files"
        className="flex items-center gap-1 bg-port-border hover:bg-port-border/70 rounded px-2 py-1 min-h-[44px] sm:min-h-0 cursor-pointer">
        {busy ? <Activity size={13} className="animate-spin" /> : <Upload size={13} />} Import generated files
      </FilePickerButton>
    </div>
  );
}
