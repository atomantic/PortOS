import { useEffect, useState } from 'react';
import { useSocket } from '../hooks/useSocket';
import * as api from '../services/api';
import Rigged3DStage from '../components/cos/Rigged3DStage';
import { useAvatarModel } from '../components/cos/avatar3d/useAvatarModel';
import { EMPTY_STATE } from '../components/cos/avatar3d/emptyStateCopy';
import { StateLabel } from '../components/cos';

// Mirrors ChiefOfStaff's socket subscription shape so the Stage page sees the
// same derived state transitions. We don't import the page itself to avoid a
// circular dep; instead we listen to the same events and apply the same rules.
function pulseSpeaking(setter) {
  setter(true);
  setTimeout(() => setter(false), 2000);
}

export default function CoSStagePage() {
  const { status, url } = useAvatarModel();
  const [agentState, setAgentState] = useState('sleeping');
  const [speaking, setSpeaking] = useState(false);
  const socket = useSocket();

  useEffect(() => {
    api.getCosStatus()
      .then((data) => { if (data?.state) setAgentState(data.state); })
      .catch(() => null);
  }, []);

  useEffect(() => {
    if (!socket) return undefined;
    const subscribe = () => socket.emit('cos:subscribe');
    if (socket.connected) subscribe(); else socket.on('connect', subscribe);

    const onStatus = (data) => { if (data && data.running === false) setAgentState('sleeping'); };
    const onSpawned = () => { setAgentState('coding'); pulseSpeaking(setSpeaking); };
    const onCompleted = () => { setAgentState('reviewing'); pulseSpeaking(setSpeaking); };
    const onHealth = () => { setAgentState('investigating'); pulseSpeaking(setSpeaking); };
    const onLog = () => { pulseSpeaking(setSpeaking); };
    const onThinking = () => { setAgentState('thinking'); pulseSpeaking(setSpeaking); };

    socket.on('cos:status', onStatus);
    socket.on('cos:agent:spawned', onSpawned);
    socket.on('cos:agent:completed', onCompleted);
    socket.on('cos:health:check', onHealth);
    socket.on('cos:log', onLog);
    socket.on('cos:thinking', onThinking);

    return () => {
      socket.off('connect', subscribe);
      socket.off('cos:status', onStatus);
      socket.off('cos:agent:spawned', onSpawned);
      socket.off('cos:agent:completed', onCompleted);
      socket.off('cos:health:check', onHealth);
      socket.off('cos:log', onLog);
      socket.off('cos:thinking', onThinking);
    };
  }, [socket]);

  if (status === 'probing') {
    return (
      <div className="flex items-center justify-center h-[70vh] text-gray-500">
        <div className="text-sm font-mono">Probing avatar model…</div>
      </div>
    );
  }
  if (status === 'missing') return <EmptyState />;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3 px-4 pt-4">
        <h1 className="text-xl font-semibold text-gray-100">Chief of Staff — Stage</h1>
        <StateLabel state={agentState} />
        {speaking && <span className="text-xs text-port-accent">speaking</span>}
      </div>
      <Rigged3DStage url={url} state={agentState} speaking={speaking} />
    </div>
  );
}

function EmptyState() {
  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      <div className="rounded-lg border border-port-border bg-port-card p-6 space-y-4">
        <h1 className="text-xl font-semibold text-gray-100">{EMPTY_STATE.title}</h1>
        <p className="text-gray-400">{EMPTY_STATE.summary}</p>
        <div>
          <div className="text-xs uppercase text-gray-500 mb-2">Required animation clips</div>
          <div className="flex flex-wrap gap-2">
            {EMPTY_STATE.requiredClips.map((c) => (
              <span
                key={c}
                className="px-2 py-1 rounded font-mono text-xs bg-port-bg border border-port-border text-gray-300"
              >
                {c}
              </span>
            ))}
          </div>
        </div>
        <div className="text-sm text-gray-400">
          See <code className="px-1 py-0.5 rounded bg-port-bg text-gray-300">docs/avatar-pipeline.md</code> for the full setup guide, including optional shape keys (visemes, blinks, brows) that unlock richer behavior.
        </div>
      </div>
    </div>
  );
}
