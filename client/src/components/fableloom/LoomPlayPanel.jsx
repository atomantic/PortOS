import { LoomPlayEmpty, LoomPlayHeader, LoomPlayScript, LoomPlayStage } from './LoomPlayViews';
import useLoomPlaybackState from './useLoomPlaybackState';

/**
 * FableLoom play panel — the reader-side chat for one episode.
 *
 * Automatic-cut nodes play once and follow their single transition. Decision
 * nodes loop their video while the reader chooses a path or types feedback.
 * Text, storyboard-image, and rendered-video previews share the same graph
 * traversal so authors can rehearse the experience at every production stage.
 *
 * TAPPING a path costs nothing: the turn carries the transition id, and the
 * server resolves the move straight off the authored graph — same endpoint,
 * no provider call, no wait. Only free text the reader typed reaches the play
 * stage; which provider/model/effort maps it is the loom's own `playSettings`
 * pin, applied server-side.
 */

export default function LoomPlayPanel({ loom, episode: initialEpisode, onClose }) {
  const { series, playback, turn, rehearsal, hosted } = useLoomPlaybackState(loom, initialEpisode);
  if (!playback.start) return <LoomPlayEmpty onClose={onClose} />;

  return (
    <div className="flex h-full min-h-0 flex-col bg-black text-white relative">
      <audio ref={hosted.hostAudioPlayerRef} className="hidden" />
      <LoomPlayHeader loom={loom} onClose={onClose} series={series} rehearsal={rehearsal} hosted={hosted} />
      <div className="flex min-h-0 flex-1 flex-col lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(20rem,32rem)]">
        <LoomPlayStage playback={playback} />
        <LoomPlayScript
          loom={loom}
          series={series}
          playback={playback}
          turn={turn}
          showInspector={rehearsal.showInspector}
        />
      </div>
    </div>
  );
}
