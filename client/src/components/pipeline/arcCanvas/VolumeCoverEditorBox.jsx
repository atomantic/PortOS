import { Loader2, ImageIcon, Layers } from 'lucide-react';
import VolumeCoverThumb from './VolumeCoverThumb.jsx';

// One panel inside VolumeCoversPanel — header (label + 2 render buttons),
// editable script textarea, and the 2-thumb proof/final row. The front-
// and back-cover panels are structurally identical; props carry only what
// actually differs (label, persisted record, render handlers, placeholder).
export default function VolumeCoverEditorBox({
  label, record, draft, setDraft, onPersist,
  onRenderProof, onRenderFinal, renderingProof, renderingFinal,
  placeholder, proofTitle, finalTitle,
}) {
  return (
    <div className="space-y-2 p-2 bg-port-bg border border-port-border rounded">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="text-xs uppercase tracking-wider text-gray-500">{label}</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onRenderProof}
            disabled={renderingProof}
            className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs bg-port-accent text-white hover:bg-port-accent/90 disabled:opacity-40"
            title={proofTitle}
          >
            {renderingProof ? <Loader2 size={10} className="animate-spin" /> : <ImageIcon size={10} />}
            Proof
          </button>
          <button
            type="button"
            onClick={onRenderFinal}
            disabled={renderingFinal}
            className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs bg-port-accent text-white hover:bg-port-accent/90 disabled:opacity-40"
            title={finalTitle}
          >
            {renderingFinal ? <Loader2 size={10} className="animate-spin" /> : <Layers size={10} />}
            Final
          </button>
        </div>
      </div>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if ((record.script || '') !== draft) onPersist(draft);
        }}
        placeholder={placeholder}
        rows={3}
        className="w-full px-2 py-1 bg-port-card border border-port-border rounded text-white text-xs"
        maxLength={8000}
      />
      <div className="grid grid-cols-2 gap-2">
        <VolumeCoverThumb slot={record.proofImage} label="Proof" emptyHint="No proof yet." />
        <VolumeCoverThumb slot={record.finalImage} label="Final" emptyHint="No final yet." />
      </div>
    </div>
  );
}
