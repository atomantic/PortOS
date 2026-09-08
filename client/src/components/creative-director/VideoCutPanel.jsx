import { Link } from 'react-router';
import ScenePreview from './ScenePreview.jsx';

export default function VideoCutPanel({ project }) {
  const trackId = project.musicBed?.trackId || project.videoDraft?.audio?.trackId;
  const cut = project.videoFinalCut || project.videoRoughCut;
  const delivered = project.status === 'complete' && project.finalVideoId === cut?.videoId;
  return <section aria-label="Assembled video" className="space-y-3 rounded border border-port-border p-4">
    <h3 className="font-medium">{delivered ? 'Final video' : cut ? 'Cut awaiting review' : 'Final assembly'}</h3>
    {project.failureReason && <p role="alert" className="text-port-warning">{project.failureReason}</p>}
    {cut?.filename ? <>
      <ScenePreview jobId={cut.videoId} src={`/data/videos/${encodeURIComponent(cut.filename)}`} label={delivered ? 'Final video preview' : 'Assembled cut preview'} />
      <p className="text-sm">{cut.durationSeconds?.toFixed(2)} seconds · {cut.audioMode} audio</p>
      <div className="flex flex-wrap gap-3 text-sm">
        <a className="underline" href={`/data/videos/${encodeURIComponent(cut.filename)}`} download>Download {delivered ? 'final video' : 'cut'}</a>
        <Link className="underline" to={`/media/history?preview=${encodeURIComponent(cut.filename)}`}>Open in Media History</Link>
      </div>
    </> : <p className="text-sm text-port-text-muted">Completed clips are assembled and checked for playback, duration, and the selected audio contract. Rough and final review precede delivery.</p>}
    <div className="flex flex-wrap gap-3 text-sm">
      {project.timelineProjectId && <Link className="underline" to={`/media/timeline/${project.timelineProjectId}`}>Open in Timeline</Link>}
      {project.collectionId && <Link className="underline" to={`/media/collections/${project.collectionId}`}>Open collection</Link>}
      {trackId && <Link className="underline" to={`/music/tracks/${encodeURIComponent(trackId)}`}>Open soundtrack</Link>}
    </div>
    {project.videoCutHistory?.length > 0 && <details><summary>Previous cuts</summary><ul className="space-y-2">{project.videoCutHistory.map((previous, index) => <li key={`${previous.videoId}-${index}`}><a className="underline" href={`/data/videos/${encodeURIComponent(previous.filename)}`} target="_blank" rel="noreferrer">Cut {index + 1} · {previous.durationSeconds?.toFixed(2)} seconds</a></li>)}</ul></details>}
  </section>;
}
