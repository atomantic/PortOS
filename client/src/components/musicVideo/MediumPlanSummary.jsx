import { MUSIC_VIDEO_MEDIUM_LABELS, summarizeMusicVideoMediumPlan } from '../../../../server/lib/musicVideoMediumPlan.js';
import { formatCount, formatTimecode } from '../../utils/formatters.js';

/** Same interval accounting as Apply; these are edit seconds, never a spend estimate. */
export default function MediumPlanSummary({ project, plan = summarizeMusicVideoMediumPlan(project) }) {
  if (plan.strategy !== 'code-first') return null;
  const labels = new Map((project.scenes || []).map((s) => [s.sceneId, s.label || s.sectionLabel || 'Scene']));
  return <section aria-label="Medium plan" className="rounded border border-port-border p-2 text-xs space-y-2">
    <p className="font-medium">Code-first plan · generated video {formatCount(plan.generatedSec, { maximumFractionDigits: 3 })} / {formatCount(plan.allowedGeneratedSec, { maximumFractionDigits: 3 })} seconds ({formatCount(plan.maxGeneratedVideoPercent, { maximumFractionDigits: 3 })}% of the song)</p>
    <p className="text-port-text-muted">Planning only: Apply saves direction. It does not generate media, select a renderer, or make procedural rendering ready. Manual generation and rendering still use their existing controls.</p>
    <p>{Object.entries(plan.secondsByMedium).map(([medium, seconds]) => `${MUSIC_VIDEO_MEDIUM_LABELS[medium]}: ${formatCount(seconds, { maximumFractionDigits: 3 })}s`).join(' · ')}</p>
    <p className="text-port-text-muted">Overlapping intervals count once per medium. Provider minimum clip lengths affect spend, not this allowance.</p>
    {plan.exceptions.length > 0 && <div>
      <p className="font-medium">Generated-footage exceptions</p>
      <ul className="list-disc pl-4">{plan.exceptions.map((entry) => <li key={entry.sceneId}>
        {labels.get(entry.sceneId) || 'Scene'} · {formatTimecode(entry.startSec)}–{formatTimecode(entry.endSec)} · {entry.rationale || 'Add a rationale.'}
      </li>)}</ul>
    </div>}
    {plan.unresolved.length > 0 && <ul className="space-y-1">{plan.unresolved.map((item, index) => <li key={`${item.sceneId || 'plan'}-${index}`} className={item.blocking ? 'text-port-error' : 'text-port-warning'}>
      {item.sceneId ? `${labels.get(item.sceneId) || 'Scene'}: ` : ''}{item.message}
    </li>)}</ul>}
  </section>;
}
