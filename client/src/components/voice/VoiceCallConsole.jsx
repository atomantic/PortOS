import { useState } from 'react';
import { Brain, ChevronDown, ChevronUp, Radio, ScanFace, Trash2, Video } from 'lucide-react';
import { voiceModelDisplayName } from '../../../../server/lib/voiceModelCatalog.js';
import AvatarChannelsPanel from './AvatarChannelsPanel';
import AvatarRuntimeSettings from './AvatarRuntimeSettings';
import SatPhoneHandset from './SatPhoneHandset';
import VoiceImageChips from './VoiceImageChips';
import ChannelBrainPicker from './ChannelBrainPicker';
import { useAvatarRuntime } from './useAvatarRuntime';
import { activeChannelOf, channelLlm, useAvatarLibrary } from './useAvatarLibrary';
import { safeReadStorage, safeWriteStorage } from '../../lib/safeStorage';
import useVoiceLlmResidency from '../../hooks/useVoiceLlmResidency';
import { voiceLlmResidencyBadge } from './voiceLlmResidencyBadge';


const TAB_KEY = 'portos.voice.callTab';
const TABS = ['video', 'brain', 'avatars'];

/**
 * Station settings as two compact disclosure chips instead of stacked cards,
 * so the handset and log stay above the fold on a phone. Each chip carries its
 * live status and opens one panel at a time; tapping the open chip folds it.
 */
function StationTabs({ runningAvatar, llmProvider, llmModel, llmResidency, onLlmSaved, agentDefaults, avatarData, avatarError, onUpdateAvatarData, onRefetchAvatar }) {
  const [tab, setTab] = useState(() => {
    const saved = safeReadStorage(TAB_KEY);
    return saved === 'none' ? null : TABS.includes(saved) ? saved : 'video';
  });
  const { data: library } = useAvatarLibrary();
  const choose = (next) => {
    const value = tab === next ? null : next;
    safeWriteStorage(TAB_KEY, value || 'none');
    setTab(value);
  };
  const videoStatus = runningAvatar ? 'Live' : 'Still portrait';
  const channel = activeChannelOf(library);
  const avatarsStatus = channel ? `CH${channel.index + 1} on air` : 'Channels';
  const brain = channelLlm(channel, llmProvider, llmModel);
  const brainModel = brain.model !== 'auto' ? voiceModelDisplayName(brain.model) : `${brain.provider} (auto)`;
  const residencyBadge = voiceLlmResidencyBadge(llmResidency);
  const brainStatus = residencyBadge ? `${brainModel} · ${residencyBadge.short}` : brainModel;
  const tabs = [
    { id: 'video', label: 'Video feed', status: videoStatus, Icon: Video, led: runningAvatar ? 'bg-port-accent shadow-[0_0_6px_rgb(var(--port-accent))]' : 'bg-port-success' },
    { id: 'brain', label: 'Voice brain', status: brainStatus, Icon: Brain, led: residencyBadge?.led },
    { id: 'avatars', label: 'Channels', status: avatarsStatus, Icon: ScanFace },
  ];

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div role="group" aria-label="Station settings" className="grid grid-cols-[repeat(auto-fit,minmax(8.5rem,1fr))] gap-2">
        {tabs.map(({ id, label, status, Icon, led }) => (
          <button
            key={id}
            type="button"
            aria-expanded={tab === id}
            aria-controls={`station-panel-${id}`}
            onClick={() => choose(id)}
            className={`flex min-h-11 min-w-0 items-center gap-2 rounded-xl border px-2.5 py-1.5 text-left transition-colors ${
              tab === id ? 'border-port-accent bg-port-accent/10' : 'border-port-border bg-port-card hover:border-port-accent'
            }`}
          >
            <Icon size={14} aria-hidden="true" className="shrink-0 text-port-accent" />
            <span className="min-w-0 flex-1">
              <span className="block font-mono text-[10px] uppercase tracking-[0.14em] text-port-text-muted">{label}</span>
              <span className="flex items-center gap-1.5 font-mono text-xs font-semibold text-port-text">
                {led && <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${led}`} />}
                <span className="truncate" title={status}>{status}</span>
              </span>
            </span>
            {tab === id ? <ChevronUp size={14} aria-hidden="true" className="shrink-0 text-port-text-muted" /> : <ChevronDown size={14} aria-hidden="true" className="shrink-0 text-port-text-muted" />}
          </button>
        ))}
      </div>

      {tab === 'video' && (
        <div id="station-panel-video">
          <AvatarRuntimeSettings data={avatarData} error={avatarError} updateData={onUpdateAvatarData} refetch={onRefetchAvatar} compact />
        </div>
      )}
      {tab === 'brain' && (
        <div id="station-panel-brain">
          <ChannelBrainPicker compact globalProvider={llmProvider} globalModel={llmModel} residency={llmResidency} onGlobalSaved={onLlmSaved} />
        </div>
      )}
      {tab === 'avatars' && (
        <div id="station-panel-avatars">
          <AvatarChannelsPanel agentDefaults={{ ...agentDefaults, provider: llmProvider, model: llmModel }} />
        </div>
      )}
    </div>
  );
}

export default function VoiceCallConsole({
  stage, history, scrollRef, interimTranscript, capturing, handsFree, canChangeMicMode,
  hotkey, draft, onDraft, onSend, onMic, onMode, onInterrupt, onEnd, onClear,
  voiceLabel, llmProvider, llmModel, onLlmSaved, agentDefaults, volume = 0.85, muted = false, onVolumeChange, onToggleMute,
  sfxEnabled = true, onToggleSfx, signalLevel = 0, visionEnabled = false, onToggleVision, images,
}) {
  const { data, error, updateData, refetch } = useAvatarRuntime();
  const runningAvatar = Boolean(!error && data?.supported && data.phase === 'running');
  // The on-air channel may run its own LLM; the server reads the same channel.
  const { data: library } = useAvatarLibrary();
  const onAirLlm = channelLlm(activeChannelOf(library), llmProvider, llmModel);
  const llmResidency = useVoiceLlmResidency({ provider: onAirLlm.provider, model: onAirLlm.model, stage });

  return (
    <section
      data-voice-widget
      aria-label="PortOS call console"
      className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(20rem,23.5rem)_minmax(0,1fr)] lg:items-start"
    >
      {/* Left column: Hero Video-Enabled Satellite Phone Handset */}
      <div className="mx-auto w-full max-w-[23.5rem] lg:mx-0">
        <SatPhoneHandset
          variant="page"
          stage={stage}
          history={history}
          scrollRef={scrollRef}
          interimTranscript={interimTranscript}
          capturing={capturing}
          handsFree={handsFree}
          canChangeMicMode={canChangeMicMode}
          hotkey={hotkey}
          draft={draft}
          onDraft={onDraft}
          onSend={onSend}
          onMic={onMic}
          onMode={onMode}
          onInterrupt={onInterrupt}
          onEnd={onEnd}
          onClear={onClear}
          voiceLabel={voiceLabel}
          llmProvider={llmProvider}
          llmModel={llmModel}
          llmResidency={llmResidency}
          onLlmSaved={onLlmSaved}
          avatarData={data}
          avatarError={error}
          onUpdateAvatarData={updateData}
          onRefetchAvatar={refetch}
          runningAvatar={runningAvatar}
          volume={volume}
          muted={muted}
          onVolumeChange={onVolumeChange}
          onToggleMute={onToggleMute}
          sfxEnabled={sfxEnabled}
          onToggleSfx={onToggleSfx}
          signalLevel={signalLevel}
          visionEnabled={visionEnabled}
          onToggleVision={onToggleVision}
          images={images}
        />
      </div>

      {/* Right column: station settings tabs + transmission log */}
      <div className="flex min-w-0 flex-col gap-4">
        <StationTabs
          runningAvatar={runningAvatar}
          llmProvider={llmProvider}
          llmModel={llmModel}
          llmResidency={llmResidency}
          onLlmSaved={onLlmSaved}
          agentDefaults={{ ...agentDefaults, voiceLabel }}
          avatarData={data}
          avatarError={error}
          onUpdateAvatarData={updateData}
          onRefetchAvatar={refetch}
        />

        {/* Transmission log (the composer lives on the handset) */}
        <section className="flex min-w-0 flex-col gap-3 rounded-2xl border border-port-border bg-port-card p-3.5 text-port-text sm:p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <Radio size={15} aria-hidden="true" className="shrink-0 text-port-accent" />
              <h2 className="font-mono text-xs font-semibold uppercase tracking-[0.14em] text-port-text">
                Transmission log
              </h2>
              {history.length > 0 && (
                <span className="rounded border border-port-border bg-port-bg px-1.5 py-0.5 font-mono text-[10px] text-port-text-muted">
                  {history.length}
                </span>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              {history.length > 0 && onClear && (
                <button
                  type="button"
                  onClick={onClear}
                  title="Clear transmission log"
                  aria-label="Clear transmission log"
                  className="satphone-key inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border px-2.5 text-port-text-muted hover:text-port-error-text"
                >
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              )}
            </div>
          </div>

          <div
            ref={scrollRef}
            className="satphone-log-well min-h-48 max-h-96 overflow-y-auto rounded-xl border p-3.5"
          >
            <div
              role="log"
              aria-live="polite"
              aria-label="Transmission log"
              className="space-y-2.5 break-words font-mono text-xs leading-relaxed sm:text-sm"
            >
              {history.length === 0 && !interimTranscript && (
                <p className="opacity-65">
                  Channel quiet. Press the TALK paddle or type on the handset.
                </p>
              )}
              {history.map((turn, i) => (
                <div key={i} className={turn.role === 'user' ? 'opacity-80' : ''}>
                  <span
                    className={`mr-2 inline-block rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                      turn.role === 'user'
                        ? 'bg-port-accent-2/15 text-port-accent-2-text'
                        : 'bg-port-accent/15 text-port-accent-text'
                    }`}
                  >
                    {turn.role === 'user' ? 'You' : 'Agent'}
                  </span>
                  {turn.text}
                  <VoiceImageChips images={turn.images} className="mt-1" />
                </div>
              ))}
            </div>
            {interimTranscript && (
              <p aria-hidden="true" className="mt-2 font-mono text-xs italic opacity-70">
                <span className="mr-2 rounded bg-port-accent-2/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-port-accent-2-text">
                  You…
                </span>
                {interimTranscript}
              </p>
            )}
          </div>

        </section>
      </div>
    </section>
  );
}
