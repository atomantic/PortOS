import { useId, useState } from 'react';
import { Loader2, BookOpen } from 'lucide-react';
import toast from '../../ui/Toast';
import { extractPipelineCanonFromScript, PIPELINE_STAGE_LABELS } from '../../../services/apiPipeline';

// Manual canon-extraction trigger for the comicScript / teleplay stages.
// Auto-extract runs only after `prose` (server/services/pipeline/textStages.js),
// so characters/places/objects introduced only in panel directions or
// dialogue cues never make it into the bible until the writer clicks this.
function getTooltip({ gated, hasContent, hasUniverse, busy, stageLabel }) {
  if (gated) return 'Saving settings…';
  if (!hasContent) return `Generate the ${stageLabel} stage first`;
  if (!hasUniverse) return 'Link a universe to the series first — extraction needs a target bible.';
  if (busy) return 'Extraction in progress…';
  return 'Extract characters / places / objects from this script and merge into the linked universe.';
}

export default function ExtractCanonButton({ issue, series, stageId, gated = false }) {
  const [busy, setBusy] = useState(false);
  const hintId = useId();
  const hasContent = !!(issue.stages?.[stageId]?.output || '').trim();
  const hasUniverse = !!series?.universeId;
  const disabled = busy || gated || !hasContent || !hasUniverse;
  const stageLabel = PIPELINE_STAGE_LABELS[stageId] || stageId;
  const tooltip = getTooltip({ gated, hasContent, hasUniverse, busy, stageLabel });

  const handleClick = async () => {
    setBusy(true);
    const result = await extractPipelineCanonFromScript(issue.id, stageId, {}, { silent: true })
      .catch((err) => {
        toast.error(err.message || 'Canon extraction failed');
        return null;
      });
    setBusy(false);
    if (!result) return;
    const c = result.extracted?.characters || 0;
    const p = result.extracted?.places || 0;
    const o = result.extracted?.objects || 0;
    const suffix = result.truncated ? ' (script truncated to fit context window)' : '';
    toast.success(
      `Extracted ${c} character${c === 1 ? '' : 's'}, ${p} place${p === 1 ? '' : 's'}, ${o} object${o === 1 ? '' : 's'} into the universe${suffix}`,
    );
  };

  // `aria-describedby` (not `aria-label`) preserves "Extract canon" as the
  // accessible name (WCAG 2.5.3 "Label in Name") and surfaces the
  // disabled-state reason as supplementary context for screen-reader +
  // keyboard users — `title` alone hides the blocker from non-mouse users.
  // Matches the pattern in ComicScriptStage.jsx#renderConceptButton.
  return (
    <>
      <button
        type="button"
        onClick={disabled ? undefined : handleClick}
        aria-disabled={disabled || undefined}
        aria-describedby={hintId}
        title={tooltip}
        className={`inline-flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs border bg-port-card text-gray-300 hover:border-port-accent/50 hover:text-white border-port-border ${
          disabled ? 'opacity-40 cursor-not-allowed' : ''
        }`}
      >
        {busy ? <Loader2 size={12} className="animate-spin" /> : <BookOpen size={12} />}
        Extract canon
      </button>
      <span id={hintId} className="sr-only">{tooltip}</span>
    </>
  );
}
