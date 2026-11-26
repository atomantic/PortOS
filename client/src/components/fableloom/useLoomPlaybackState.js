import { useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import { playLoomTurn } from '../../services/apiFableLoom.js';
import toast from '../ui/Toast';
import { abortHostedSpeech, playHostedSpeech, releaseDroppedHostedSpeech } from './hostedSpeechPlayback';
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

function resolveEpisodeDelivery(loom, initialEpisode, playEpisodeId) {
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
  return { episode, episodeIndex, nextEpisode, nextEpisodeIndex, overnightVoicemail, nextSeasonTeaser };
}

export default function useLoomPlaybackState(loom, initialEpisode) {
  const [playEpisodeId, setPlayEpisodeId] = useState(initialEpisode.id);
  const {
    episode, episodeIndex, nextEpisode, nextEpisodeIndex, overnightVoicemail, nextSeasonTeaser,
  } = resolveEpisodeDelivery(loom, initialEpisode, playEpisodeId);
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
  const [failedVideoIds, setFailedVideoIds] = useState(() => new Set());
  const [showInspector, setShowInspector] = useState(false);
  const [hostedModalOpen, setHostedModalOpen] = useState(false);
  const [hostedSession, setHostedSession] = useState(null);
  const [hostedAudienceConnected, setHostedAudienceConnected] = useState(false);
  const [hostedTurnPhase, setHostedTurnPhase] = useState('idle');
  const hostAudioPlayerRef = useRef(null);
  const hostedSpeechRef = useRef(null);
  const scrollRef = useRef(null);
  const sessionGenerationRef = useRef(0);
  const hostedSocketRef = useRef(null);
  // The episode id the server-side hosted session is currently bound to —
  // null while no session is active, otherwise re-armed to the current
  // episode the moment a session connects (it was created for THAT episode).
  const hostedEpisodeIdRef = useRef(null);
  // Names the episode a pending `hosted:episode:switch` targeted, so a
  // resulting `hosted:session:ended{reason:'episode_not_ready'}` can name it
  // in the toast even though the server payload carries only the reason.
  const pendingHostedEpisodeSwitchRef = useRef(null);
  // Always the CURRENT episode id, read from the `hosted:session:sync`
  // handler below (which closes over the socket-connect effect's render and
  // would otherwise see a stale `episode`).
  const latestEpisodeIdRef = useRef(episode.id);
  useEffect(() => { latestEpisodeIdRef.current = episode.id; }, [episode.id]);

  // Socket connection when hosted session is active
  useEffect(() => {
    if (!hostedSession?.id) return;
    const socket = io('/fableloom-hosted', {
      auth: { sessionId: hostedSession.id, token: hostedSession.hostToken, role: 'host' },
      transports: ['websocket', 'polling'],
    });
    hostedSocketRef.current = socket;

    socket.on('hosted:peer:status', (data) => {
      setHostedAudienceConnected(Boolean(data.hasAudienceConnected));
    });

    socket.on('hosted:turn:phase', (data) => {
      setHostedTurnPhase(data.phase || 'idle');
      hostedSpeechRef.current = releaseDroppedHostedSpeech(hostedSpeechRef.current, data);
    });

    socket.on('hosted:error', (data) => {
      toast.error(data?.message || 'Hosted session error');
    });

    socket.on('hosted:turn:transcript', (item) => {
      setTranscript((prev) => [...prev, { role: item.role === 'audience' ? 'reader' : 'narrator', text: item.text }]);
    });

    socket.on('hosted:turn:tts', (data) => {
      hostedSpeechRef.current = playHostedSpeech(hostAudioPlayerRef.current, {
        socket,
        previous: hostedSpeechRef.current,
        turnId: data?.turnId,
        target: data?.target,
        expectedTarget: 'host',
        mimeType: data?.mimeType,
        audioBase64: data?.audio,
      });
    });

    // The server rejects a second `hosted:episode:switch` sent while an
    // earlier one is still in flight (409 EPISODE_SWITCH_IN_PROGRESS) — a
    // host who advances episodes faster than that round trip would otherwise
    // strand the hosted session on whichever earlier target won the race.
    // Every `hosted:session:sync` (including the one the in-flight switch
    // itself broadcasts on commit) names the server's current episode; if it
    // no longer matches what the host is actually showing, request the
    // CURRENT one again rather than leaving the mismatch unresolved (#8112).
    socket.on('hosted:session:sync', (data) => {
      // A resync is the recovery when a phase frame was missed. An absent
      // turnPhase must not clear a phase the room already published.
      if (data?.turnPhase) setHostedTurnPhase(data.turnPhase);
      if (data?.episodeId && data.episodeId !== latestEpisodeIdRef.current) {
        hostedEpisodeIdRef.current = latestEpisodeIdRef.current;
        pendingHostedEpisodeSwitchRef.current = { id: latestEpisodeIdRef.current, label: pendingHostedEpisodeSwitchRef.current?.label };
        hostedSocketRef.current?.emit('hosted:episode:switch', { episodeId: latestEpisodeIdRef.current });
      }
    });

    socket.on('hosted:story:transition', (data) => {
      // The move already committed on the server. Hold index, a rehearsed
      // exit, and a failed render belong to the scene being left (#17269).
      setActiveHoldIndex(0);
      setPendingTransition(null);
      setFailedVideoIds(new Set());
      setHostedTurnPhase('idle');
      if (data.node) {
        setScene(data.node);
        setPlaybackPhase(data.playbackPhase || 'hold');
        setTranscript((prev) => [...prev, { role: 'scene', node: data.node }]);
      }
    });

    socket.on('hosted:session:ended', (data) => {
      abortHostedSpeech(hostedSpeechRef.current);
      hostedSpeechRef.current = null;
      setHostedSession(null);
      setHostedAudienceConnected(false);
      setHostedTurnPhase('idle');
      if (data?.reason === 'episode_not_ready') {
        const label = pendingHostedEpisodeSwitchRef.current?.label || 'The next episode';
        toast.error(`Hosted session ended — ${label} isn't ready for hosted play.`);
      }
      pendingHostedEpisodeSwitchRef.current = null;
    });

    return () => {
      abortHostedSpeech(hostedSpeechRef.current);
      hostedSpeechRef.current = null;
      socket.disconnect();
      hostedSocketRef.current = null;
    };
  }, [hostedSession?.id, hostedSession?.hostToken]);

  // Re-bind the server-side hosted session when the host advances to a
  // different episode (e.g. the "Next: Episode N" button). Without this the
  // server keeps resolving audience turns against the OLD episode's graph —
  // `findNode` throws, and every turn silently falls back to canned
  // narration while the UI still claims the session is connected (#8112).
  // Runs in the commit BEFORE the scene/playback-sync effect below re-points
  // `scene` at the new episode's opening node, so the switch always reaches
  // the server ahead of the first `hosted:playback:update` for that node.
  useEffect(() => {
    if (!hostedSession?.id) {
      hostedEpisodeIdRef.current = null;
      return;
    }
    if (hostedEpisodeIdRef.current === null) {
      // A session that just connected/was created is already bound to the
      // episode that was active when it was created — nothing to switch.
      hostedEpisodeIdRef.current = episode.id;
      return;
    }
    if (hostedEpisodeIdRef.current === episode.id) return;
    hostedEpisodeIdRef.current = episode.id;
    pendingHostedEpisodeSwitchRef.current = {
      id: episode.id,
      label: `Episode ${episode.number || episodeIndex + 1}`,
    };
    hostedSocketRef.current?.emit('hosted:episode:switch', { episodeId: episode.id });
  }, [episode.id, episode.number, episodeIndex, hostedSession?.id]);

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
  const currentVideoFailed = failedVideoIds.has(currentVideoId);
  const activePreviewMode = previewMode === 'auto'
    ? bestAvailablePreviewMode(scene, currentVideoId, currentVideoFailed)
    : previewMode;

  const restart = () => {
    sessionGenerationRef.current += 1;
    setScene(start);
    setPlaybackPhase(initialPhaseForNode(start));
    setActiveHoldIndex(0);
    setPendingTransition(null);
    setTranscript(start ? [{ role: 'scene', node: start }] : []);
    setMessage('');
    setFailedVideoIds(new Set());
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
    const generation = sessionGenerationRef.current;
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
    if (sessionGenerationRef.current !== generation) return;

    const additions = [];
    if (result.narration) additions.push({ role: 'narrator', text: result.narration });
    if (result.action === 'move' && result.node) {
      setScene(result.node);
      setPlaybackPhase(initialPhaseForNode(result.node));
      setActiveHoldIndex(0);
      setPendingTransition(null);
      setFailedVideoIds(new Set());
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

    const exitClipId = scene.playbackAssets?.exitByTransition?.[choice.id];
    if (exitClipId && !failedVideoIds.has(exitClipId) && activePreviewMode === 'video') {
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

  const enterHold = () => {
    setPlaybackPhase('hold');
    setActiveHoldIndex(0);
  };

  const commitExit = () => {
    if (!pendingTransition) return;
    setPendingTransition(null);
    setPlaybackPhase('hold');
    runTurn({ transitionId: pendingTransition.id }, transcript);
  };

  const handleVideoEnded = () => {
    if (playbackPhase === 'entry') {
      if (automaticCut) {
        advanceCut();
      } else {
        enterHold();
      }
    } else if (playbackPhase === 'hold') {
      const holdLoops = scene?.playbackAssets?.holdLoopVideoHistoryIds || [];
      if (holdLoops.length > 1) {
        setActiveHoldIndex((prev) => (prev + 1) % holdLoops.length);
      }
    } else if (playbackPhase === 'exit') {
      commitExit();
    }
  };

  const handleVideoError = () => {
    setFailedVideoIds((prev) => new Set(prev).add(currentVideoId));
    if (playbackPhase === 'exit') {
      commitExit();
    } else if (playbackPhase === 'entry' && !automaticCut) {
      enterHold();
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

  return {
    series: {
      episode, episodeIndex, nextEpisode, nextEpisodeIndex, overnightVoicemail, nextSeasonTeaser,
      setPlayEpisodeId,
    },
    playback: {
      start, scene, playbackPhase, ended, audienceConnected, automaticCut, currentAsset,
      currentVideoId, currentVideoFailed, activePreviewMode, handleVideoEnded, handleVideoError,
    },
    turn: { transcript, scrollRef, message, setMessage, restart, sending, takePath, advanceCut, send },
    rehearsal: { previewMode, setPreviewMode, showInspector, setShowInspector },
    hosted: {
      hostedModalOpen, setHostedModalOpen, hostedSession, setHostedSession, hostedAudienceConnected,
      setHostedAudienceConnected, hostedTurnPhase, hostAudioPlayerRef,
    },
  };
}
