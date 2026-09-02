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
import { io } from 'socket.io-client';
import { Loader2, RotateCcw, Send, Flag, Volume2, Mic, CheckCircle2, AlertCircle, QrCode, Smartphone, X } from 'lucide-react';
import MediaImage from '../MediaImage';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import { playLoomTurn } from '../../services/api';
import { sceneProseClass } from './fieldStyles';
import LoomHostedSessionModal from './LoomHostedSessionModal';
import { audienceCanParticipate } from '../../../../server/lib/fableLoomParticipation.js';
import {
  resolveFableLoomProtagonistPresence,
  resolvePlaybackPhaseAsset,
} from '../../../../server/lib/fableLoomPlayback.js';

const findNode = (episode, id) => episode?.nodes.find((n) => n.id === id) || null;
const hasPlayableStart = (episode) => !!findNode(episode, episode?.startNodeId);

// Reader-facing projection of an authored node — the OPENING scene only, which
// the panel shows before any turn has been taken. Every later scene arrives
// from the play endpoint already in this shape (the server's `publicNode`).
const asPublic = (node, loom) => (node ? {
  id: node.id,
  title: node.title,
  prose: node.prose,
  image: node.image,
  videoHistoryId: node.videoHistoryId,
  playbackAssets: node.playbackAssets || null,
  interactionWindow: node.interactionWindow || null,
  protagonistPresence: resolveFableLoomProtagonistPresence(node, loom),
  playbackMode: node.playbackMode || 'decision',
  audienceConnection: node.audienceConnection || 'disconnected',
  isEnding: !!node.isEnding,
  endingLabel: node.endingLabel,
  choices: (node.transitions || []).map((t) => ({ id: t.id, intent: t.intent })),
} : null);

const initialPhaseForNode = (node) => {
  if (!node) return 'ended';
  if (node.isEnding) return 'ended';
  if (node.playbackAssets?.entryVideoHistoryId) return 'entry';
  if (node.playbackAssets?.holdLoopVideoHistoryIds?.length) return 'hold';
  if (node.videoHistoryId) {
    return node.playbackMode === 'cut' ? 'entry' : 'hold';
  }
  return 'hold';
};

const bestAvailablePreviewMode = (node, videoId, videoFailed) => {
  if (videoId && !videoFailed) return 'video';
  if (node?.image) return 'image';
  // Without a still to fall back to, keep the failed-video state visible so
  // authors can distinguish an unavailable render from a scene with no media.
  if (videoId) return 'video';
  return 'text';
};

export default function LoomPlayPanel({ loom, episode: initialEpisode, onClose }) {
  const [playEpisodeId, setPlayEpisodeId] = useState(initialEpisode.id);
  const episode = loom.episodes?.find((item) => item.id === playEpisodeId) || initialEpisode;
  const episodeIndex = loom.episodes?.findIndex((item) => item.id === episode.id) ?? -1;
  const nextEpisodeIndex = episodeIndex >= 0
    ? (loom.episodes || []).findIndex((item, index) => index > episodeIndex && hasPlayableStart(item))
    : -1;
  const nextEpisode = nextEpisodeIndex >= 0 ? loom.episodes[nextEpisodeIndex] : null;
  const deliveryOptions = loom.seriesPlan?.deliveryOptions || {};
  const overnightVoicemail = nextEpisode && deliveryOptions.overnightVoicemails === true
    ? (loom.seriesPlan?.interEpisodeVoicemails || []).find((item) => (
      item.fromEpisodeId === episode.id && item.toEpisodeId === nextEpisode.id
    )) || { title: 'A message left overnight', transcript: '' }
    : null;
  const nextSeasonTeaser = !nextEpisode && deliveryOptions.nextSeasonTeaser === true
    ? loom.seriesPlan?.nextSeasonTeaser || { title: 'A signal beyond the ending', transcript: '' }
    : null;
  // Anchored on scalars so an authoring echo elsewhere in the loom (a node
  // PATCH, a drag) doesn't mint a new `start` identity and wipe an
  // in-progress read-through. The trade: mid-session edits to the opening
  // scene's text don't reach an open drawer until restart.
  const start = useMemo(
    () => asPublic(findNode(episode, episode?.startNodeId), loom),
    [episode.id, episode.startNodeId, loom.participationMode, loom.protagonistCharacterId],
  );
  const [scene, setScene] = useState(start);
  const [playbackPhase, setPlaybackPhase] = useState(() => initialPhaseForNode(start));
  const [activeHoldIndex, setActiveHoldIndex] = useState(0);
  const [pendingTransition, setPendingTransition] = useState(null);
  const [transcript, setTranscript] = useState(() => (start ? [{ role: 'scene', node: start }] : []));
  const [message, setMessage] = useState('');
  const [previewMode, setPreviewMode] = useState('auto');
  const [failedVideoId, setFailedVideoId] = useState(null);
  const [showInspector, setShowInspector] = useState(false);
  const [hostedModalOpen, setHostedModalOpen] = useState(false);
  const [hostedSession, setHostedSession] = useState(null);
  const [hostedAudienceConnected, setHostedAudienceConnected] = useState(false);
  const [hostedTurnPhase, setHostedTurnPhase] = useState('idle');
  const hostAudioPlayerRef = useRef(null);
  const scrollRef = useRef(null);
  const hostedSocketRef = useRef(null);

  // Socket connection when hosted session is active
  useEffect(() => {
    if (!hostedSession?.id) return;
    const socket = io('/fableloom-hosted', {
      auth: { sessionId: hostedSession.id, token: hostedSession.token, role: 'host' },
      transports: ['websocket', 'polling'],
    });
    hostedSocketRef.current = socket;

    socket.on('hosted:peer:status', (data) => {
      setHostedAudienceConnected(Boolean(data.hasAudienceConnected));
    });

    socket.on('hosted:turn:phase', (data) => {
      setHostedTurnPhase(data.phase || 'idle');
    });

    socket.on('hosted:turn:transcript', (item) => {
      setTranscript((prev) => [...prev, { role: item.role === 'audience' ? 'reader' : 'narrator', text: item.text }]);
    });

    socket.on('hosted:turn:tts', (data) => {
      if (data.target === 'host' && data.audio && hostAudioPlayerRef.current) {
        try {
          hostAudioPlayerRef.current.src = `data:${data.mimeType || 'audio/wav'};base64,${data.audio}`;
          hostAudioPlayerRef.current.play().catch(() => null);
        } catch (err) {
          console.warn('TTS playback error:', err);
        }
      }
    });

    socket.on('hosted:story:transition', (data) => {
      if (data.node) {
        setScene(data.node);
        setPlaybackPhase(data.playbackPhase || 'hold');
        setTranscript((prev) => [...prev, { role: 'scene', node: data.node }]);
      }
    });

    socket.on('hosted:session:ended', () => {
      setHostedSession(null);
      setHostedAudienceConnected(false);
      setHostedTurnPhase('idle');
    });

    return () => {
      socket.disconnect();
      hostedSocketRef.current = null;
    };
  }, [hostedSession?.id, hostedSession?.token]);

  // Sync playback phase & scene updates to hosted audience
  useEffect(() => {
    if (hostedSocketRef.current && hostedSession?.id && scene?.id) {
      hostedSocketRef.current.emit('hosted:playback:update', {
        nodeId: scene.id,
        phase: playbackPhase,
        activeHoldIndex,
      });
    }
  }, [scene?.id, playbackPhase, activeHoldIndex, hostedSession?.id]);
  // Mirrors the server's terminal rule: an ending, or a dead-end scene with
  // no paths out, ends the read-through.
  const ended = !!scene && (scene.isEnding || !scene.choices?.length);
  const audienceConnected = audienceCanParticipate(loom, scene);
  const automaticCut = !!scene && !scene.isEnding
    && scene.choices?.length > 0
    && (!audienceConnected || (scene.playbackMode === 'cut' && scene.choices.length === 1));

  // Resolve current active video asset and occupancy
  const currentAsset = useMemo(() => resolvePlaybackPhaseAsset({
    node: scene,
    phase: playbackPhase,
    activeHoldIndex,
    transitionId: pendingTransition?.id || null,
  }), [scene, playbackPhase, activeHoldIndex, pendingTransition]);
  const currentVideoId = currentAsset.videoHistoryId || scene?.videoHistoryId || null;
  const currentVideoFailed = Boolean(currentVideoId && failedVideoId === currentVideoId);
  const activePreviewMode = previewMode === 'auto'
    ? bestAvailablePreviewMode(scene, currentVideoId, currentVideoFailed)
    : previewMode;

  const restart = () => {
    setScene(start);
    setPlaybackPhase(initialPhaseForNode(start));
    setActiveHoldIndex(0);
    setPendingTransition(null);
    setTranscript(start ? [{ role: 'scene', node: start }] : []);
    setMessage('');
    setFailedVideoId(null);
  };

  useEffect(() => { setPlayEpisodeId(initialEpisode.id); }, [initialEpisode.id]);

  useEffect(() => { setPreviewMode('auto'); }, [episode.id]);

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
      setPlaybackPhase(initialPhaseForNode(result.node));
      setActiveHoldIndex(0);
      setPendingTransition(null);
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
  // carries its id. If a transition-specific exit clip exists, rehearse the exit
  // clip before committing the move.
  const takePath = (choice) => {
    if (sending || !scene) return;
    setMessage('');
    const history = [...transcript, { role: 'reader', text: choice.intent }];
    setTranscript(history);

    const hasExitClip = Boolean(scene.playbackAssets?.exitByTransition?.[choice.id]);
    if (hasExitClip && activePreviewMode === 'video') {
      setPendingTransition(choice);
      setPlaybackPhase('exit');
    } else {
      runTurn({ transitionId: choice.id }, history);
    }
  };

  const advanceCut = () => {
    if (sending || !automaticCut) return;
    runTurn({ transitionId: scene.choices[0].id }, transcript);
  };

  const handleVideoEnded = () => {
    if (playbackPhase === 'entry') {
      if (automaticCut) {
        advanceCut();
      } else {
        setPlaybackPhase('hold');
        setActiveHoldIndex(0);
      }
    } else if (playbackPhase === 'hold') {
      const holdLoops = scene?.playbackAssets?.holdLoopVideoHistoryIds || [];
      if (holdLoops.length > 1) {
        setActiveHoldIndex((prev) => (prev + 1) % holdLoops.length);
      }
    } else if (playbackPhase === 'exit') {
      if (pendingTransition) {
        const choice = pendingTransition;
        setPendingTransition(null);
        runTurn({ transitionId: choice.id }, transcript);
      }
    }
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
      <div className="always-dark flex h-full flex-col bg-black text-white">
        {onClose && (
          <div className="flex justify-end p-3">
            <button
              type="button"
              onClick={onClose}
              aria-label="Close player"
              className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-gray-300 hover:bg-white/10 hover:text-white"
            >
              <X size={20} />
            </button>
          </div>
        )}
        <p className="m-auto p-4 text-sm text-gray-400">
          This episode has no opening scene yet — weave or add scenes first.
        </p>
      </div>
    );
  }

  const liveVoiceActive = Boolean(
    scene?.interactionWindow?.enabled && audienceConnected && currentAsset.safeForLiveVoice && playbackPhase === 'hold',
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-black text-white relative">
      <audio ref={hostAudioPlayerRef} className="hidden" />

      {hostedModalOpen && (
        <LoomHostedSessionModal
          loom={loom}
          episode={episode}
          isOpen={hostedModalOpen}
          onClose={() => setHostedModalOpen(false)}
          activeSession={hostedSession}
          hasAudienceConnected={hostedAudienceConnected}
          onSessionCreated={(sess, full) => {
            setHostedSession(full || sess);
          }}
          onSessionEnded={() => {
            setHostedSession(null);
            setHostedAudienceConnected(false);
          }}
        />
      )}

      <header className="always-dark flex shrink-0 items-center justify-between gap-3 border-b border-white/10 bg-black px-3 py-2.5 sm:px-4">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{loom.name}</p>
          <div className="mt-0.5 flex min-w-0 items-center gap-2">
            <span className="truncate text-xs text-gray-400">Episode {episode.number || episodeIndex + 1 || 1}: {episode.title || 'Untitled'}</span>
            <button
              type="button"
              onClick={() => setShowInspector((prev) => !prev)}
              className="shrink-0 text-[10px] text-port-accent hover:underline"
            >
              {showInspector ? 'Hide rehearsal' : 'Rehearsal details'}
            </button>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setHostedModalOpen(true)}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs border transition-colors ${
              hostedSession
                ? 'bg-port-accent/15 border-port-accent text-port-accent font-medium'
                : 'border-white/20 bg-white/5 text-gray-200 hover:border-port-accent'
            }`}
            title="Host two-device QR play session"
          >
            <QrCode size={13} />
            <span className="hidden sm:inline">{hostedSession ? 'Hosted (Active)' : 'Host (QR)'}</span>
            {hostedSession && (
              <span className={`w-1.5 h-1.5 rounded-full ${hostedAudienceConnected ? 'bg-emerald-400' : 'bg-amber-400 animate-pulse'}`} />
            )}
          </button>

          <select
            id="loom-preview-mode"
            aria-label="Preview stage"
            className="rounded border border-white/20 bg-black px-2 py-1 text-xs text-gray-200"
            value={previewMode}
            onChange={(event) => setPreviewMode(event.target.value)}
          >
            <option value="auto">Best available</option>
            <option value="text">Text</option>
            <option value="image">Storyboard images</option>
            <option value="video">Rendered video</option>
          </select>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close player"
              className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-gray-300 hover:bg-white/10 hover:text-white"
            >
              <X size={20} />
            </button>
          )}
        </div>
      </header>

      {hostedSession && (
        <div className="bg-indigo-500/10 border-b border-indigo-500/20 px-3 py-1.5 text-xs flex items-center justify-between text-indigo-400">
          <div className="flex items-center gap-2">
            <Smartphone size={13} />
            <span className="font-medium">Hosted Session:</span>
            <span>
              {hostedTurnPhase === 'listening' ? 'Audience is speaking…' :
               hostedTurnPhase === 'thinking' ? 'Protagonist is deciding…' :
               hostedTurnPhase === 'speaking' ? 'Protagonist is answering…' :
               hostedAudienceConnected ? 'Audience connected (Phone mic ready)' : 'Waiting for phone to scan QR link…'}
            </span>
          </div>
          <button
            type="button"
            onClick={() => setHostedModalOpen(true)}
            className="text-[11px] underline hover:text-indigo-300"
          >
            Manage QR
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(20rem,32rem)]">
        <section
          className="relative flex min-h-[16rem] h-[42vh] items-center justify-center overflow-hidden bg-black lg:h-auto lg:min-h-0"
          aria-label="Scene media"
        >
          <SceneMedia
            node={scene}
            previewMode={activePreviewMode}
            onCutEnded={handleVideoEnded}
            playbackPhase={playbackPhase}
            activeAsset={currentAsset}
            automaticCut={automaticCut}
            videoFailed={currentVideoFailed}
            onVideoError={() => setFailedVideoId(currentVideoId)}
          />
          <div className="port-media-overlay-strong absolute left-3 top-3 max-w-[calc(100%-1.5rem)] rounded px-2.5 py-1.5 sm:left-4 sm:top-4">
            <p className="truncate text-[10px] uppercase tracking-[0.18em] opacity-70">
              {scene?.isEnding ? (scene.endingLabel || 'Ending') : scene?.id === start.id ? 'Opening' : 'Now playing'}
            </p>
            <p className="truncate text-sm font-medium">{scene?.title || 'Untitled scene'}</p>
          </div>
          {liveVoiceActive && (
            <div className="port-media-overlay absolute bottom-3 left-3 right-3 flex items-center justify-between gap-3 rounded px-3 py-2 text-xs sm:bottom-4 sm:left-4 sm:right-auto sm:min-w-80" role="status">
              <span className="flex items-center gap-1.5 font-medium">
                <Mic size={13} className="animate-pulse" /> Off-screen voice window open
              </span>
              <span className="flex items-center gap-1 text-[10px] opacity-75">
                <Volume2 size={11} /> Ambience ducked {scene?.interactionWindow?.ambientDuckDb ?? -8} dB
              </span>
            </div>
          )}
        </section>

        <aside className="flex min-h-0 flex-1 flex-col border-t border-port-border bg-port-card text-port-text lg:border-l lg:border-t-0" aria-label={loom.format === 'teleplay' ? 'Teleplay' : 'Story script'}>
      {showInspector && (
        <div className="shrink-0 bg-port-bg/60 border-b border-port-border p-2.5 text-xs space-y-1.5" role="region" aria-label="Playback rehearsal">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold uppercase tracking-wider text-[10px] text-port-text-muted">Phase:</span>
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-medium uppercase ${
              playbackPhase === 'hold' ? 'bg-port-accent/20 text-port-accent' :
              playbackPhase === 'entry' ? 'bg-blue-500/20 text-blue-400' :
              playbackPhase === 'exit' ? 'bg-amber-500/20 text-amber-400' :
              'bg-port-bg border border-port-border text-port-text-muted'
            }`}>
              {playbackPhase}
            </span>
            {currentAsset.videoHistoryId && (
              <span className="text-[10px] font-mono text-port-text-muted truncate max-w-[140px]" title={currentAsset.videoHistoryId}>
                Asset: {currentAsset.videoHistoryId}
              </span>
            )}
            {scene.interactionWindow?.enabled && (
              <span className="flex items-center gap-1 text-[10px]">
                {currentAsset.safeForLiveVoice ? (
                  <span className="text-port-success flex items-center gap-0.5">
                    <CheckCircle2 size={11} /> Safe for live voice
                  </span>
                ) : (
                  <span className="text-port-error flex items-center gap-0.5">
                    <AlertCircle size={11} /> Unsafe (dialogue/blocking)
                  </span>
                )}
              </span>
            )}
          </div>
          {scene.interactionWindow?.enabled && (
            <div className="text-[10px] text-port-text-muted flex items-center gap-2">
              <span>Duck level: {scene.interactionWindow.ambientDuckDb ?? -8} dB</span>
              <span>Presence: {scene.interactionWindow.protagonistPresence || 'offscreen'}</span>
            </div>
          )}
          {scene.protagonistPresence && !scene.interactionWindow?.enabled && (
            <div className="text-[10px] text-port-text-muted">
              Visual protagonist: {scene.protagonistPresence === 'offscreen' ? 'off-screen — side-device conversation' : 'on-screen'}
            </div>
          )}
        </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
        {transcript.map((turn, i) => {
          if (turn.role === 'scene') {
            if (i === latestSceneTurnIndex) return null;
            const historicalCut = !turn.node.isEnding
              && turn.node.choices?.length > 0
              && (!audienceCanParticipate(loom, turn.node)
                || (turn.node.playbackMode === 'cut' && turn.node.choices.length === 1));
            return (
              <SceneScriptCard
                key={i}
                node={turn.node}
                format={loom.format}
                automaticCut={historicalCut}
                helperMode={loom.participationMode === 'helper'}
                historical
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
        <SceneScriptCard
          node={scene}
          format={loom.format}
          automaticCut={automaticCut}
          helperMode={loom.participationMode === 'helper'}
        />
        {ended && (
          <div className="flex items-center gap-2 justify-center text-port-success text-sm font-medium py-2">
            <Flag size={14} />
            {scene?.endingLabel ? `Ending: ${scene.endingLabel}` : 'The End'}
          </div>
        )}
        {ended && overnightVoicemail && (
          <SeriesDeliveryCard
            label={`Overnight voicemail · Episode ${episode.number || episodeIndex + 1} → Episode ${nextEpisode.number || nextEpisodeIndex + 1}`}
            title={overnightVoicemail.title || 'A message left overnight'}
            transcript={overnightVoicemail.transcript}
            emptyMessage="This episode boundary is configured for a voicemail, but its transcript is still waiting to be authored."
          />
        )}
        {ended && nextSeasonTeaser && (
          <SeriesDeliveryCard
            label="Next-season teaser"
            title={nextSeasonTeaser.title || 'A signal beyond the ending'}
            transcript={nextSeasonTeaser.transcript}
            emptyMessage="The next-season teaser is enabled, but its cliffhanger is still waiting to be authored."
          />
        )}
      </div>
      <div className="shrink-0 border-t border-port-border bg-port-card p-3 space-y-2">
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
              disabled={sending || (activePreviewMode === 'video' && Boolean(currentVideoId) && !currentVideoFailed)}
              className="flex-1 px-3 py-2 rounded bg-port-accent text-white text-sm disabled:opacity-50"
            >
              {sending
                ? 'Loading next cut…'
                : activePreviewMode === 'video' && currentVideoId && !currentVideoFailed
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
        </aside>
      </div>
    </div>
  );
}

function SeriesDeliveryCard({ label, title, transcript, emptyMessage }) {
  return (
    <div className="border border-port-accent/40 rounded-lg bg-port-accent/5 p-3" role="region" aria-label={label}>
      <div className="text-[10px] uppercase tracking-wide text-port-accent mb-1">{label}</div>
      <div className="text-sm font-medium mb-1">{title}</div>
      <p className="text-sm whitespace-pre-wrap">
        {transcript?.trim() || emptyMessage}
      </p>
    </div>
  );
}

function SceneMedia({
  node, previewMode, onCutEnded, automaticCut,
  playbackPhase = 'hold', activeAsset = null, videoFailed = false, onVideoError,
}) {
  if (!node) return null;
  const videoId = activeAsset?.videoHistoryId || node.videoHistoryId || null;
  const showVideo = previewMode === 'video' && Boolean(videoId) && !videoFailed;
  const showImage = previewMode === 'image' && node.image;

  // Decision nodes with single hold loop loop natively; otherwise ended event rotates or advances phase
  const holdLoopCount = node.playbackAssets?.holdLoopVideoHistoryIds?.length || 0;
  const shouldLoopNatively = !automaticCut && !node.isEnding && playbackPhase === 'hold' && holdLoopCount <= 1;

  if (!showVideo && !showImage) {
    const message = previewMode === 'image'
      ? 'No storyboard image rendered for this cut yet.'
      : previewMode === 'video'
        ? videoFailed
          ? 'The rendered video is unavailable; advance manually or retry after rendering.'
          : 'No video rendered for this cut yet.'
        : 'Text rehearsal';
    return (
      <div className="always-dark flex h-full w-full items-center justify-center bg-[radial-gradient(circle_at_center,_#202020_0%,_#050505_65%)] px-8 text-center">
        <div>
          <p className="text-xs uppercase tracking-[0.22em] text-gray-500">{previewMode === 'text' ? 'FableLoom' : 'Media pending'}</p>
          <p className="mt-2 text-sm text-gray-300">{message}</p>
        </div>
      </div>
    );
  }

  return (
    <>
      {showVideo && (
        <video
          key={videoId}
          controls
          autoPlay
          muted
          playsInline
          loop={shouldLoopNatively}
          onEnded={onCutEnded}
          onError={onVideoError}
          src={`/data/videos/${encodeURIComponent(videoId)}.mp4`}
          aria-label={node.title || 'Scene video'}
          className="h-full w-full bg-black object-contain"
        />
      )}
      {showImage && (
        <MediaImage src={`/data/images/${node.image}`} alt={node.title || 'Scene'} className="h-full w-full object-contain" />
      )}
    </>
  );
}

function SceneScriptCard({
  node, format, automaticCut, helperMode = false, historical = false,
}) {
  if (!node) return null;

  return (
    <article className={historical ? 'border-b border-port-border/70 pb-4 opacity-70' : ''}>
      <div className="mb-2 flex items-center justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.16em] text-port-text-muted">
            {historical ? 'Earlier scene' : 'Scene description & dialogue'}
          </div>
          <h3 className="mt-0.5 text-sm font-semibold text-port-text">{node.title || 'Untitled scene'}</h3>
        </div>
        {!historical && <span className="shrink-0 rounded-full border border-port-border px-2 py-0.5 text-[10px] uppercase tracking-wide text-port-text-muted">{format === 'teleplay' ? 'Teleplay' : 'Story'}</span>}
      </div>
      <p className={sceneProseClass(format)}>
        {node.prose || 'No scene description has been authored yet.'}
      </p>
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
        {!node.isEnding && node.protagonistPresence === 'offscreen' && (
          <p className="mt-1 text-xs text-port-accent">
            Protagonist off-screen — keep this decision loop running while the audience conversation happens on the side device.
          </p>
        )}
    </article>
  );
}
