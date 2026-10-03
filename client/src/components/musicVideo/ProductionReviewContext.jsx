import DevArtifactPreview from './DevArtifactPreview.jsx';
import { formatTimecode, formatCount } from '../../utils/formatters.js';

/** The saved evidence immediately preceding a revision-bound decision. */
export default function ProductionReviewContext({ stage, project, basis, approved, onOpenArtifact, onArtReady }) {
  const draft = project.productionReview?.draft || {};
  const guide = project.devArtifacts?.find(a => a.id === draft.guideArtifactId && !a.deleted);
  const document = draft.storyboardSource === 'document';
  const shots = draft.storyboard || [];
  const sheets = (project.devArtifacts || []).filter(a => !a.deleted && a.kind === 'storyboard');
  return <section aria-label={`${stage === 'art' ? 'Art direction' : 'Storyboard'} review content`} className="min-w-0 space-y-3 py-3">
    <p className="text-xs text-port-text-muted break-words">Project v{project.version || 1} · {approved ? 'Approved saved revision' : 'Current saved revision'} · {basis?.slice(0, 12) || 'Loading revision…'}</p>
    {stage === 'art' ? <>
      {guide ? <figure className="min-w-0 space-y-2">
        <figcaption className="text-sm font-medium">Selected visual guide: {guide.title} · v{guide.version || 1}</figcaption>
        <DevArtifactPreview key={`${guide.id}:${guide.version}`} projectId={project.id} artifact={guide} onReady={onArtReady} />
        <button type="button" className="min-h-[44px] text-sm text-port-accent" onClick={() => onOpenArtifact(guide.id)}>Open guide and version history</button>
      </figure> : <p role="status">No current visual guide selected. Choose a Development file in the planning editor below.</p>}
      <dl className="space-y-2 text-sm">{[['Cast', draft.cast], ['Environments', draft.environments], ['Visual language', draft.visualLanguage], ['Motion and energy', draft.motionLanguage]].map(([label, value]) => <div key={label}><dt className="font-medium">{label}</dt><dd className="whitespace-pre-wrap break-words">{value || 'Missing — complete this in the planning editor.'}</dd></div>)}</dl>
    </> : <>
      <p className="text-sm font-medium">{formatCount(shots.length)} {document ? 'document shots' : 'storyboard shots'} · {document ? `Document ${project.composition?.document?.directory?.split('/').at(-1) || 'not selected'}` : 'Current Board timing'}</p>
      {!shots.length && <p role="status">No storyboard shots to review. Import the current document’s shot manifest or prepare Board scenes below.</p>}
      <ol className="max-h-[60vh] overflow-y-auto space-y-3 rounded border border-port-border p-2" aria-label="Current storyboard shots" tabIndex={0}>
        {shots.map((shot, index) => {
          const scene = document ? shot : project.scenes?.find(s => s.sceneId === shot.sceneId);
          return <li key={shot.id || shot.sceneId || index} className="border-b border-port-border pb-3 text-sm">
            <p className="font-medium">{index + 1}. {scene?.label || shot.label || 'Shot'} · {Number.isFinite(scene?.startSec) ? `${formatTimecode(scene.startSec)}–${formatTimecode(scene.endSec)}` : 'Timing missing'}</p>
            <p className="whitespace-pre-wrap break-words">{shot.action || 'Action missing'}</p>
            <dl className="text-xs text-port-text-muted space-y-1">{['staging', 'camera', 'transition'].map(key => <div key={key}><dt className="capitalize font-medium">{key}</dt><dd className="whitespace-pre-wrap break-words">{shot[key] || 'Missing'}</dd></div>)}</dl>
            <p className="text-xs">Lyric anchors: {(shot.lyricCueIds || []).map(id => project.lyricCues?.find(c => c.id === id)?.text || id).join(' · ') || (draft.lyricsMode === 'instrumental' ? 'Instrumental' : 'None selected')}</p>
          </li>;
        })}
      </ol>
      {sheets.length > 0 && <details><summary className="min-h-[44px] cursor-pointer py-2 text-sm">Storyboard reference sheets ({formatCount(sheets.length)})</summary>
        <p className="text-xs text-port-text-muted">Reference files may predate the current document. Compare them with the exact saved shots above.</p>
        {sheets.map(sheet => <details key={sheet.id}><summary className="min-h-[44px] cursor-pointer py-2 text-sm">{sheet.title} · v{sheet.version || 1}</summary><DevArtifactPreview projectId={project.id} artifact={sheet} /></details>)}
      </details>}
    </>}
  </section>;
}
