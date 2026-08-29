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

import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, RotateCcw, Send, Flag } from 'lucide-react';
import MediaImage from '../MediaImage';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import { playLoomTurn } from '../../services/api';
import { sceneProseClass } from './fieldStyles';
import { audienceCanParticipate } from '../../../../server/lib/fableLoomParticipation.js';

const findNode = (episode, id) => episode?.nodes.find((n) => n.id === id) || null;
const hasPlayableStart = (episode) => !!findNode(episode, episode?.startNodeId);

// Reader-facing projection of an authored node — the OPENING scene only, which
// the panel shows before any turn has been taken. Every later scene arrives
// from the play endpoint already in this shape (the server's `publicNode`).
const asPublic = (node) => (node ? {
  id: node.id,
  title: node.title,
  prose: node.prose,
  image: node.image,
  videoHistoryId: node.videoHistoryId,
  playbackMode: node.playbackMode || 'decision',
  audienceConnection: node.audienceConnection || 'disconnected',
  isEnding: !!node.isEnding,
  endingLabel: node.endingLabel,
  choices: (node.transitions || []).map((t) => ({ id: t.id, intent: t.intent })),
} : null);

export default function LoomPlayPanel({ loom, episode: initialEpisode }) {
  const [playEpisodeId, setPlayEpisodeId] = useState(initialEpisode.id);
  const episode = loom.episodes?.find((item) => item.id === playEpisodeId) || initialEpisode;
  const episodeIndex = loom.episodes?.findIndex((item) => item.id === episode.id) ?? -1;
  const nextEpisodeIndex = episodeIndex >= 0
    ? (loom.episodes || []).findIndex((item, index) => index > episodeIndex && hasPlayableStart(item))
    : -1;
  const nextEpisode = nextEpisodeIndex >= 0 ? loom.episodes[nextEpisodeIndex] : null;
  // Anchored on scalars so an authoring echo elsewhere in the loom (a node
  // PATCH, a drag) doesn't mint a new `start` identity and wipe an
  // in-progress read-through. The trade: mid-session edits to the opening
  // scene's text don't reach an open drawer until restart.
  const start = useMemo(
    () => asPublic(findNode(episode, episode?.startNodeId)),
    [episode.id, episode.startNodeId],
  );
  const [scene, setScene] = useState(start);
  const [transcript, setTranscript] = useState(() => (start ? [{ role: 'scene', node: start }] : []));
  const [message, setMessage] = useState('');
  const [previewMode, setPreviewMode] = useState('text');
  const [failedVideoId, setFailedVideoId] = useState(null);
  const scrollRef = useRef(null);
  // Mirrors the server's terminal rule: an ending, or a dead-end scene with
  // no paths out, ends the read-through.
  const ended = !!scene && (scene.isEnding || !scene.choices?.length);
  const audienceConnected = audienceCanParticipate(loom, scene);
  const automaticCut = !!scene && !scene.isEnding
    && scene.choices?.length > 0
    && (!audienceConnected || (scene.playbackMode === 'cut' && scene.choices.length === 1));

  const restart = () => {
    setScene(start);
    setTranscript(start ? [{ role: 'scene', node: start }] : []);
    setMessage('');
    setFailedVideoId(null);
  };

  useEffect(() => { setPlayEpisodeId(initialEpisode.id); }, [initialEpisode.id]);

  // An episode switch (or a changed opening scene) re-anchors the session.
  useEffect(() => { restart(); }, [start]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [transcript, scene]);

  // One turn, either lane. `transitionId` is the tapped-path lane the server
  // resolves off the graph with no provider call; `message` is free text the
  // play stage matches. The panel never resolves a move itself — one owner for
  // the rule, on the side that holds the authored graph.
  const [runTurn, sending] = useAsyncAction(async (turn, history) => {
    const result = await playLoomTurn(loom.id, episode.id, {
      nodeId: scene.id,
      ...turn,
      // The transcript state also holds scene cards ({ role: 'scene', node })
      // — the API accepts only reader/narrator text turns, so filter first or
      // every turn after the first move fails validation.
      transcript: history
        .filter((t) => t.role === 'reader' || t.role === 'narrator')
        .slice(-12)
        .map(({ role, text: t }) => ({ role, text: t })),
    }, { silent: true });
    const additions = [];
    if (result.narration) additions.push({ role: 'narrator', text: result.narration });
    if (result.action === 'move' && result.node) {
      setScene(result.node);
      additions.push({ role: 'scene', node: result.node });
    }
    // A turn that moves nowhere and says nothing would read as the app
    // ignoring the reader. It happens for real: a path whose target scene the
    // author deleted stays on the graph (the editor surfaces it as an error
    // rather than silently rewriting edges), and the server answers 'stay'
    // with no narration.
    if (!additions.length) additions.push({ role: 'narrator', text: 'Nothing comes of it.' });
    setTranscript((prev) => [...prev, ...additions]);
  }, { errorMessage: 'The narrator lost the thread — try again' });

  // Tapping a path: the reader already named the transition, so the turn
  // carries its id and the server moves them without an intent-matching call.
  const takePath = (choice) => {
    if (sending || !scene) return;
    setMessage('');
    const history = [...transcript, { role: 'reader', text: choice.intent }];
    setTranscript(history);
    runTurn({ transitionId: choice.id }, history);
  };

  const advanceCut = () => {
    if (sending || !automaticCut) return;
    runTurn({ transitionId: scene.choices[0].id }, transcript);
  };

  const send = () => {
    const text = message.trim();
    if (!text || sending || !scene) return;
    setMessage('');
    const history = [...transcript, { role: 'reader', text }];
    setTranscript(history);
    runTurn({ message: text }, history);
  };

  const latestSceneTurnIndex = transcript.reduce(
    (latest, turn, index) => (turn.role === 'scene' ? index : latest),
    -1,
  );

  if (!start) {
    return (
      <p className="p-4 text-sm text-port-text-muted">
        This episode has no opening scene yet — weave or add scenes first.
      </p>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-port-border p-3 flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-medium">Episode {episode.number || episodeIndex + 1 || 1}: {episode.title || 'Untitled'}</p>
          <label htmlFor="loom-preview-mode" className="text-xs text-port-text-muted">Preview stage</label>
        </div>
        <select
          id="loom-preview-mode"
          className="bg-port-bg border border-port-border rounded px-2 py-1 text-xs"
          value={previewMode}
          onChange={(event) => setPreviewMode(event.target.value)}
        >
          <option value="text">Text</option>
          <option value="image">Storyboard images</option>
          <option value="video">Rendered video</option>
        </select>
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
        {transcript.map((turn, i) => {
          if (turn.role === 'scene') {
            if (previewMode === 'video' || i === latestSceneTurnIndex) return null;
            const historicalCut = !turn.node.isEnding
              && turn.node.choices?.length > 0
              && (!audienceCanParticipate(loom, turn.node)
                || (turn.node.playbackMode === 'cut' && turn.node.choices.length === 1));
            return (
              <SceneCard
                key={i}
                node={turn.node}
                format={loom.format}
                previewMode={previewMode}
                automaticCut={historicalCut}
                helperMode={loom.participationMode === 'helper'}
              />
            );
          }
          return (
            <div key={i} className={turn.role === 'reader' ? 'text-right' : ''}>
              <div
                className={`inline-block max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap text-left ${
                  turn.role === 'reader'
                    ? 'bg-port-accent/15 text-port-text'
                    : 'bg-port-card border border-port-border text-port-text'
                }`}
              >
                {turn.text}
              </div>
            </div>
          );
        })}
        <SceneCard
          node={scene}
          isOpening={scene?.id === start.id}
          format={loom.format}
          previewMode={previewMode}
          onCutEnded={advanceCut}
          automaticCut={automaticCut}
          helperMode={loom.participationMode === 'helper'}
          videoFailed={!!scene.videoHistoryId && failedVideoId === scene.videoHistoryId}
          onVideoError={() => setFailedVideoId(scene.videoHistoryId)}
        />
        {ended && (
          <div className="flex items-center gap-2 justify-center text-port-success text-sm font-medium py-2">
            <Flag size={14} />
            {scene?.endingLabel ? `Ending: ${scene.endingLabel}` : 'The End'}
          </div>
        )}
      </div>
      <div className="border-t border-port-border p-3 space-y-2">
        {!ended && audienceConnected && !automaticCut && scene?.choices?.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {scene.choices.filter((c) => c.intent).map((c) => (
              <button
                key={c.id}
                type="button"
                aria-label={`Take path: ${c.intent}`}
                onClick={() => takePath(c)}
                className="text-xs px-2 py-1 rounded-full border border-port-border text-port-text-muted hover:border-port-accent hover:text-port-accent"
              >
                {c.intent}
              </button>
            ))}
          </div>
        )}
        {automaticCut && (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={advanceCut}
              disabled={sending || (previewMode === 'video' && !!scene.videoHistoryId && failedVideoId !== scene.videoHistoryId)}
              className="flex-1 px-3 py-2 rounded bg-port-accent text-white text-sm disabled:opacity-50"
            >
              {sending
                ? 'Loading next cut…'
                : previewMode === 'video' && scene.videoHistoryId && failedVideoId !== scene.videoHistoryId
                  ? 'Video advances automatically'
                  : 'Next cut'}
            </button>
            <button
              type="button"
              onClick={restart}
              className="px-3 py-2 rounded bg-port-accent/15 text-port-accent text-sm"
            >
              <RotateCcw size={14} className="inline mr-1" /> Restart
            </button>
          </div>
        )}
        {!ended && !audienceConnected && (
          <p className="text-xs text-port-text-muted" role="status">
            Connection unavailable — the story follows its canon path until {loom.audienceCommunicationMedium || 'the audience channel'} is restored.
          </p>
        )}
        {!automaticCut && (ended || audienceConnected) && <div className="flex gap-2">
          <input
            className="flex-1 bg-port-bg border border-port-border rounded px-3 py-2 text-sm"
            placeholder={ended
              ? 'The story has ended'
              : loom.participationMode === 'helper' ? 'What do you tell the protagonist?' : 'What do you do?'}
            aria-label="Your action"
            value={message}
            disabled={ended || sending}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
          />
          {ended ? (
            <button
              type="button"
              onClick={() => (nextEpisode ? setPlayEpisodeId(nextEpisode.id) : restart())}
              className="flex items-center gap-1.5 px-3 py-2 rounded bg-port-accent/15 text-port-accent text-sm"
            >
              <RotateCcw size={14} /> {nextEpisode ? `Next: Episode ${nextEpisode.number || nextEpisodeIndex + 1}` : 'Play again'}
            </button>
          ) : (
            <button
              type="button"
              onClick={send}
              disabled={sending || !message.trim()}
              aria-label="Send"
              className="px-3 py-2 rounded bg-port-accent text-white disabled:opacity-50"
            >
              {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
            </button>
          )}
        </div>}
      </div>
    </div>
  );
}

function SceneCard({
  node, isOpening = false, format, previewMode, onCutEnded, automaticCut,
  helperMode = false, videoFailed = false, onVideoError,
}) {
  if (!node) return null;
  const showVideo = previewMode === 'video' && node.videoHistoryId && !videoFailed;
  const showImage = previewMode === 'image' && node.image;
  return (
    <div className="border border-port-border rounded-lg overflow-hidden bg-port-card">
      {showVideo && (
        <video
          key={node.videoHistoryId}
          controls
          autoPlay
          muted
          playsInline
          loop={!automaticCut && !node.isEnding}
          onEnded={automaticCut ? onCutEnded : undefined}
          onError={onVideoError}
          src={`/data/videos/${encodeURIComponent(node.videoHistoryId)}.mp4`}
          aria-label={node.title || 'Scene video'}
          className="w-full max-h-[60vh] bg-black object-contain"
        />
      )}
      {showImage && (
        <MediaImage src={`/data/images/${node.image}`} alt={node.title || 'Scene'} className="w-full max-h-56 object-cover" />
      )}
      <div className="p-3">
        <div className="text-xs uppercase tracking-wide text-port-text-muted mb-1">
          {isOpening ? 'Opening' : node.isEnding ? (node.endingLabel || 'Ending') : node.title || 'Scene'}
        </div>
        {previewMode === 'text' && <p className={sceneProseClass(format)}>{node.prose}</p>}
        {previewMode === 'image' && !node.image && <p className="text-sm text-port-text-muted">No storyboard image rendered for this cut yet.</p>}
        {previewMode === 'video' && (!node.videoHistoryId || videoFailed) && (
          <p className="text-sm text-port-text-muted">
            {videoFailed ? 'The rendered video is unavailable; advance manually or retry after rendering.' : 'No video rendered for this cut yet.'}
          </p>
        )}
        {!node.isEnding && (
          <p className="mt-2 text-xs text-port-text-muted">
            {automaticCut
              ? 'Automatic cut'
              : helperMode && node.audienceConnection !== 'connected'
                ? 'Canon path — audience disconnected'
                : node.audienceConnection === 'connected'
                  ? 'Audience connected — waits for input'
                  : 'Decision loop — waits for viewer input'}
          </p>
        )}
      </div>
    </div>
  );
}
