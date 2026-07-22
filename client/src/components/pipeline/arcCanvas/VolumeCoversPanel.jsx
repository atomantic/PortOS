import { useEffect, useState } from 'react';
import { Loader2, Wand2, ChevronRight, ChevronDown, FileDown } from 'lucide-react';
import toast from '../../ui/Toast';
import {
  updatePipelineSeason,
  generatePipelineVolumeCover, generatePipelineVolumeBackCover,
  generatePipelineVolumeCoverConcepts,
  pipelineVolumePdfUrl,
} from '../../../services/api';
import VolumeCoverEditorBox from './VolumeCoverEditorBox.jsx';

export default function VolumeCoversPanel({ series, season, seasons, onSeriesUpdate }) {
  const [expanded, setExpanded] = useState(true);
  const cover = season.cover || { script: '', proofImage: null, finalImage: null };
  const backCover = season.backCover || { script: '', proofImage: null, finalImage: null };

  // Local draft text so keystrokes don't round-trip until blur.
  const [draftCover, setDraftCover] = useState(cover.script || '');
  const [draftBack, setDraftBack] = useState(backCover.script || '');
  useEffect(() => { setDraftCover(cover.script || ''); }, [cover.script]);
  useEffect(() => { setDraftBack(backCover.script || ''); }, [backCover.script]);

  const [generatingConcepts, setGeneratingConcepts] = useState(false);
  // One in-flight flag per target × variant. Indexed object so the four
  // render buttons share an enable/disable shape without a 4-bool sprawl.
  const [busy, setBusy] = useState({ coverProof: false, coverFinal: false, backProof: false, backFinal: false });

  // Splice the updated season back into series.seasons[] in place — never
  // refetch the series list when a partial update will do.
  const replaceSeasonInSeries = (updatedSeason) => {
    if (!updatedSeason) return;
    onSeriesUpdate({
      ...series,
      seasons: (seasons || []).map((s) => (s.id === updatedSeason.id ? updatedSeason : s)),
    });
  };

  const persistScript = async (target, nextScript) => {
    const updatedSeason = await updatePipelineSeason(series.id, season.id, {
      [target]: { script: nextScript },
    }, { silent: true }).catch((err) => {
      toast.error(err.message || 'Save failed');
      return null;
    });
    if (updatedSeason) replaceSeasonInSeries(updatedSeason);
  };

  const handleGenerateConcepts = async () => {
    setGeneratingConcepts(true);
    const result = await generatePipelineVolumeCoverConcepts(series.id, season.id, {
      commit: true,
      providerOverride: series.llm?.provider || undefined,
      modelOverride: series.llm?.model || undefined,
    }, { silent: true }).catch((err) => {
      toast.error(err.message || 'Failed to generate cover concepts');
      return null;
    });
    setGeneratingConcepts(false);
    if (!result) return;
    if (result.series) {
      // Server returned the full updated series — use it for the in-place splice.
      onSeriesUpdate(result.series);
    } else if (result.season) {
      replaceSeasonInSeries(result.season);
    }
    const parts = [];
    if (result.seeded?.cover) parts.push('front');
    if (result.seeded?.backCover) parts.push('back');
    if (parts.length === 0) {
      toast.success('Cover concepts generated (existing edits preserved)');
    } else {
      toast.success(`Volume ${season.number} ${parts.join(' + ')} cover concept${parts.length > 1 ? 's' : ''} seeded`);
    }
  };

  const handleRender = async (target, variant) => {
    const busyKey = `${target === 'cover' ? 'cover' : 'back'}${variant === 'final' ? 'Final' : 'Proof'}`;
    setBusy((b) => ({ ...b, [busyKey]: true }));
    const apiCall = target === 'cover' ? generatePipelineVolumeCover : generatePipelineVolumeBackCover;
    const scriptKey = target === 'cover' ? 'coverScript' : 'backCoverScript';
    const draftText = target === 'cover' ? draftCover : draftBack;
    const label = target === 'cover' ? 'cover' : 'back cover';
    const result = await apiCall(series.id, season.id, {
      [scriptKey]: draftText || '',
      target: variant,
    }, { silent: true }).catch((err) => {
      toast.error(err.message || `Failed to render ${variant} ${label}`);
      return null;
    });
    setBusy((b) => ({ ...b, [busyKey]: false }));
    if (!result) return;
    if (result.series) onSeriesUpdate(result.series);
    else if (result.season) replaceSeasonInSeries(result.season);
    toast.success(`Queued ${result.mode} volume ${variant} ${label} render (${result.jobId.slice(0, 8)})`);
  };

  // PDF readiness mirrors the server's pickRenderedFilename fallback chain
  // (finalImage → proofImage → legacy filename) — see lib/renderSlot.js.
  const volCoverRendered = !!(cover.finalImage?.filename || cover.proofImage?.filename || cover.filename);
  const volPdfReady = volCoverRendered;
  const volPdfHref = volPdfReady ? pipelineVolumePdfUrl(series.id, season.id) : undefined;
  const volPdfTitle = volPdfReady
    ? 'Compile a trade-paperback PDF — volume front + every issue (cover, pages, back) + volume back.'
    : 'Render the volume front cover first.';

  return (
    <div className="px-3 pb-3 border-t border-port-border/50 pt-2 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="inline-flex items-center gap-1 text-xs text-gray-300 hover:text-white"
          aria-expanded={expanded}
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          Volume covers
          <span className="text-[10px] text-gray-500">
            {volCoverRendered ? '(front rendered)' : '(none yet)'}
          </span>
        </button>
        <button
          type="button"
          onClick={handleGenerateConcepts}
          disabled={generatingConcepts}
          title="Have the LLM propose front + back cover concepts for the volume"
          className="ml-auto inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-port-accent hover:text-white border border-port-border bg-port-bg hover:border-port-accent/40 disabled:opacity-40"
        >
          {generatingConcepts ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
          Generate cover concepts (LLM)
        </button>
        <a
          href={volPdfHref}
          aria-disabled={!volPdfReady}
          onClick={(e) => { if (!volPdfReady) e.preventDefault(); }}
          title={volPdfTitle}
          className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs border ${
            volPdfReady
              ? 'text-white bg-port-card border-port-border hover:border-port-accent/50'
              : 'text-gray-500 bg-port-card border-port-border cursor-not-allowed'
          }`}
        >
          <FileDown size={12} /> Compile volume PDF
        </a>
      </div>

      {expanded ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <VolumeCoverEditorBox
            label="Front cover"
            record={cover}
            draft={draftCover}
            setDraft={setDraftCover}
            onPersist={(next) => persistScript('cover', next)}
            onRenderProof={() => handleRender('cover', 'proof')}
            onRenderFinal={() => handleRender('cover', 'final')}
            renderingProof={busy.coverProof}
            renderingFinal={busy.coverFinal}
            placeholder="Volume front cover concept — iconic image for the whole volume. Series masthead + 'Vol. N' tag added by the renderer."
            proofTitle="Render a fast proof of the volume front cover"
            finalTitle="Render the hi-res final volume front cover"
          />
          <VolumeCoverEditorBox
            label="Back cover"
            record={backCover}
            draft={draftBack}
            setDraft={setDraftBack}
            onPersist={(next) => persistScript('backCover', next)}
            onRenderProof={() => handleRender('backCover', 'proof')}
            onRenderFinal={() => handleRender('backCover', 'final')}
            renderingProof={busy.backProof}
            renderingFinal={busy.backFinal}
            placeholder="Volume back cover concept — illustration only. No text, no masthead. Quiet companion image."
            proofTitle="Render a fast proof of the volume back cover"
            finalTitle="Render the hi-res final volume back cover"
          />
        </div>
      ) : null}
    </div>
  );
}
