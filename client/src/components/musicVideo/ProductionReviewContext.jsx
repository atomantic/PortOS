import { ChevronRight, Play } from 'lucide-react';
import DevArtifactPreview from './DevArtifactPreview.jsx';
import { formatTimecode, formatCount } from '../../utils/formatters.js';

const FOLD = 'min-h-[44px] cursor-pointer py-2 text-sm';

/**
 * The saved evidence immediately preceding a revision-bound decision. People
 * review visually — the visual guide for art, the player for the storyboard —
 * so the written recipe (art direction text, each shot's action, staging,
 * camera, transition and lyric anchors) is a deep dive behind a fold, one shot
 * at a time, never a wall of text above the Approve button. `onSeek(startSec)`
 * plays the docked preview from a shot.
 */
export default function ProductionReviewContext({ stage, project, onOpenArtifact, onArtReady, onSeek = null }) {
  const draft = project.productionReview?.draft || {};
  const guide = project.devArtifacts?.find(a => a.id === draft.guideArtifactId && !a.deleted);
  const document = draft.storyboardSource === 'document';
  const shots = draft.storyboard || [];
  const sheets = (project.devArtifacts || []).filter(a => !a.deleted && a.kind === 'storyboard');
  return <section aria-label={`${stage === 'art' ? 'Art direction' : 'Storyboard'} review content`} className="min-w-0 space-y-3 py-3">
    {stage === 'art' ? <>
      {guide ? <figure className="min-w-0 space-y-2">
        <figcaption className="text-sm font-medium">Selected visual guide: {guide.title} · v{guide.version || 1}</figcaption>
        <DevArtifactPreview key={`${guide.id}:${guide.version}`} projectId={project.id} artifact={guide} onReady={onArtReady} />
        <button type="button" className="min-h-[44px] text-sm text-port-accent" onClick={() => onOpenArtifact(guide.id)}>Open guide and version history</button>
      </figure> : <p role="status">No current visual guide selected. Choose a Development file in the planning editor below.</p>}
      <details>
        <summary className={FOLD}>Written art direction</summary>
        <dl className="space-y-2 text-sm">{[['Cast', draft.cast], ['Environments', draft.environments], ['Visual language', draft.visualLanguage], ['Motion and energy', draft.motionLanguage]].map(([label, value]) => <div key={label}><dt className="font-medium">{label}</dt><dd className="whitespace-pre-wrap break-words">{value || 'Missing — complete this in the planning editor.'}</dd></div>)}</dl>
      </details>
    </> : <>
      <p className="text-sm">
        Watch the storyboard in the player, then approve. {formatCount(shots.length)} {document ? 'document shots' : 'storyboard shots'}
        {document ? ` · document ${project.composition?.document?.directory?.split('/').at(-1) || 'not selected'}` : ' · current Board timing'}.
      </p>
      {!shots.length && <p role="status">No storyboard shots to review. Import the current document’s shot manifest or prepare Board scenes below.</p>}
      {shots.length > 0 && <ol className="max-h-[45vh] divide-y divide-port-border overflow-y-auto rounded border border-port-border" aria-label="Current storyboard shots" tabIndex={0}>
        {shots.map((shot, index) => {
          const scene = document ? shot : project.scenes?.find(s => s.sceneId === shot.sceneId);
          const timed = Number.isFinite(scene?.startSec);
          return <li key={shot.id || shot.sceneId || index} className="flex min-w-0 items-start gap-1 px-2 text-sm">
            {onSeek && timed
              ? <button type="button" onClick={() => onSeek(scene.startSec)} aria-label={`Play shot ${index + 1} in the preview`}
                className="mt-1.5 flex h-8 w-8 shrink-0 items-center justify-center rounded text-port-accent hover:bg-port-border/40"><Play size={14} aria-hidden="true" /></button>
              : <span className="w-8 shrink-0" />}
            <details className="group min-w-0 flex-1">
              {/* A flex summary drops the native marker, so the row draws its own chevron. */}
              <summary className={`${FOLD} flex items-center gap-2 marker:content-none [&::-webkit-details-marker]:hidden`}>
                <ChevronRight size={14} aria-hidden="true" className="shrink-0 text-port-text-muted transition-transform group-open:rotate-90" />
                <span className="w-12 shrink-0 font-mono text-xs text-port-text-muted">{timed ? formatTimecode(scene.startSec).replace(/\.\d+$/, '') : '—'}</span>
                <span className="min-w-0 truncate">{scene?.label || shot.label || shot.id || `Shot ${index + 1}`}</span>
              </summary>
              <div className="space-y-1 pb-2">
                <p className="whitespace-pre-wrap break-words">{shot.action || 'Action missing'}</p>
                <dl className="text-xs text-port-text-muted space-y-1">{['staging', 'camera', 'transition'].map(key => <div key={key}><dt className="capitalize font-medium">{key}</dt><dd className="whitespace-pre-wrap break-words">{shot[key] || 'Missing'}</dd></div>)}</dl>
                <p className="text-xs">Lyric anchors: {(shot.lyricCueIds || []).map(id => project.lyricCues?.find(c => c.id === id)?.text || id).join(' · ') || (draft.lyricsMode === 'instrumental' ? 'Instrumental' : 'None selected')}</p>
                {timed && <p className="text-xs text-port-text-muted">{formatTimecode(scene.startSec)}–{formatTimecode(scene.endSec)}</p>}
              </div>
            </details>
          </li>;
        })}
      </ol>}
      {sheets.length > 0 && <details><summary className={FOLD}>Storyboard reference sheets ({formatCount(sheets.length)})</summary>
        <p className="text-xs text-port-text-muted">Reference files may predate the current document. Compare them with the exact saved shots above.</p>
        {sheets.map(sheet => <details key={sheet.id}><summary className={FOLD}>{sheet.title} · v{sheet.version || 1}</summary><DevArtifactPreview projectId={project.id} artifact={sheet} /></details>)}
      </details>}
    </>}
  </section>;
}
