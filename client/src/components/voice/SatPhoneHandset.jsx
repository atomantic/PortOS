import { useId, useState } from 'react';
import { saveAvatarChannels } from '../../services/apiVoiceAvatar';
import { activeChannelOf, channelLlm, channelVoiceLabel, useAvatarLibrary } from './useAvatarLibrary';
import { SatPhoneFaceplate, SatPhoneSetup, SatPhoneSpeaker } from './SatPhoneFaceplate';
import SatPhoneViewfinder from './SatPhoneViewfinder';
import { SatPhoneActionKeys, SatPhoneTelemetry } from './SatPhoneControls';
import SatPhoneConversation from './SatPhoneConversation';
import SatPhoneComposer from './SatPhoneComposer';
import useVoiceLlmResidency from '../../hooks/useVoiceLlmResidency';
import { useRealtimeCallState } from './useRealtimeConnecting';
import { stopActiveRealtimeCalls } from '../../services/voiceRealtime';

/**
 * Video-enabled Satellite Phone / Tactical Transceiver Handset.
 *
 * Shared between the bottom-left floating voice agent (`variant="floating"`)
 * and the dedicated full-page Voice Call station (`variant="page"`). Every
 * indicator, dial, paddle, and key maps to real voice/audio functionality. The
 * channel key steps through the transceiver channels; each channel wears an
 * avatar from the shared Avatars collection on the viewfinder.
 */
export default function SatPhoneHandset({
  variant = 'floating',
  stage,
  history,
  scrollRef,
  interimTranscript,
  capturing,
  handsFree,
  canChangeMicMode,
  hotkey = 'Space',
  draft,
  onDraft,
  onSend,
  onMic,
  onMode,
  onInterrupt,
  onEnd,
  onClear,
  agentName = '',
  voiceLabel,
  llmProvider,
  llmModel,
  // The page console reads residency once for its chips and passes it down;
  // the floating handset reads its own.
  llmResidency,
  onLlmSaved,
  avatarData,
  runningAvatar,
  volume,
  muted,
  onVolumeChange,
  onToggleMute,
  ttsRate = 1,
  onTtsRateChange,
  signalLevel = 0,
  signalSpectrum = null,
  visionEnabled = false,
  onToggleVision,
  onOpenBrain,
  brainExpanded,
  brainControlsId,
  onTuneChannel,
  // { pending, attachFiles, remove } — images queued for the next turn.
  images,
  isVoiceOutputTab = true,
  onClaimVoiceOutput,
  // Floating-only controls
  collapsed = false,
  onToggleCollapsed,
  conversationId,
  inputRef,
  onCompactMode,
  onHideWidget,
  onMinimizeMobile,
}) {
  const [showFloatingSetup, setShowFloatingSetup] = useState(false);
  const floatingSetupId = useId();
  const { data: library, updateData: updateLibrary } = useAvatarLibrary();
  const channel = activeChannelOf(library);
  const channels = library?.channels ?? [];
  // The telemetry shows what the on-air channel's agent actually runs.
  const onAirLlm = channelLlm(channel, llmProvider, llmModel);
  const selectChannel = (index) =>
    saveAvatarChannels({ active: index }).then(updateLibrary).catch(() => {});
  const isFloating = variant === 'floating';
  const handleOpenBrain = isFloating
    ? () => setShowFloatingSetup((value) => !value)
    : onOpenBrain;
  const handleTuneChannel = isFloating
    ? (index) => {
      if (index !== (channel?.index ?? 0)) selectChannel(index);
      setShowFloatingSetup(true);
    }
    : onTuneChannel;
  const ownResidency = useVoiceLlmResidency({ provider: onAirLlm.provider, model: onAirLlm.model, stage, enabled: llmResidency === undefined });
  const residency = llmResidency === undefined ? ownResidency : llmResidency;
  const { active: realtimeActive, connecting: realtimeConnecting } = useRealtimeCallState();
  const handleEndRealtime = () => {
    stopActiveRealtimeCalls();
    onEnd?.();
  };
  const onAirAgentName = channel?.agent?.name?.trim() || agentName?.trim() || channel?.label?.trim() || '';
  const liveAttr = capturing ? 'tx' : (stage === 'speaking' || stage === 'thinking' || stage === 'loading') ? 'rx' : 'idle';

  return (
    <div className={`relative flex flex-col ${isFloating ? 'w-[21.25rem] max-w-[calc(100vw-2rem)]' : 'w-full'}`}>
      {/* Main machined transceiver chassis */}
      <div
        data-live={liveAttr}
        className={`satphone-chassis relative flex flex-col rounded-2xl border text-port-text ${
          isFloating ? 'gap-2 p-2.5 max-h-[calc(100dvh-2rem)] overflow-y-auto' : 'gap-2.5 p-3 sm:p-3.5'
        }`}
      >
        <SatPhoneFaceplate
          isFloating={isFloating}
          stage={stage}
          capturing={capturing}
          runningAvatar={runningAvatar}
          avatarData={avatarData}
          showSetup={showFloatingSetup}
          setupControlsId={floatingSetupId}
          onToggleSetup={() => setShowFloatingSetup((value) => !value)}
          onCompactMode={onCompactMode}
          onMinimizeMobile={onMinimizeMobile}
          onHideWidget={onHideWidget}
        />

        {isFloating && showFloatingSetup && (
          <SatPhoneSetup
            id={floatingSetupId}
            llmProvider={llmProvider}
            llmModel={llmModel}
            llmResidency={residency}
            onLlmSaved={onLlmSaved}
          />
        )}

        <SatPhoneViewfinder
          avatarFilename={channel?.avatar ?? null}
          channel={channel}
          agentName={onAirAgentName}
          runningAvatar={runningAvatar}
          connecting={avatarData?.phase === 'starting' || realtimeConnecting}
          stage={stage}
          capturing={capturing}
          signalLevel={signalLevel}
          muted={muted}
          visionEnabled={visionEnabled}
          onToggleVision={onToggleVision}
        />

        <SatPhoneTelemetry
          isFloating={isFloating}
          stage={stage}
          capturing={capturing}
          handsFree={handsFree}
          canChangeMicMode={canChangeMicMode}
          hotkey={hotkey}
          onMic={onMic}
          onMode={onMode}
          channels={channels}
          activeChannelIndex={channel?.index ?? 0}
          globalAgentName={agentName}
          onSelectChannel={selectChannel}
          onTuneChannel={handleTuneChannel}
          onOpenBrain={handleOpenBrain}
          brainExpanded={isFloating ? showFloatingSetup : brainExpanded}
          brainControlsId={isFloating ? floatingSetupId : brainControlsId}
          volume={volume}
          muted={muted}
          voiceLabel={channelVoiceLabel(channel, voiceLabel)}
          llmProvider={onAirLlm.provider}
          llmModel={onAirLlm.model}
          llmResidency={residency}
          signalLevel={signalLevel}
          signalSpectrum={signalSpectrum}
          onVolumeChange={onVolumeChange}
          onToggleMute={onToggleMute}
        />

        <SatPhoneActionKeys
          stage={stage}
          realtimeActive={realtimeActive}
          muted={muted}
          onToggleMute={onToggleMute}
          ttsRate={ttsRate}
          onTtsRateChange={onTtsRateChange}
          visionEnabled={visionEnabled}
          onToggleVision={onToggleVision}
          onInterrupt={onInterrupt}
          onEnd={handleEndRealtime}
        />

        {/* Page handset: type without scrolling to the log below. The floating
            handset's composer sits under its own log instead. */}
        {!isFloating && <SatPhoneComposer draft={draft} onDraft={onDraft} onSend={onSend} inputRef={inputRef} images={images} />}

        <SatPhoneSpeaker
          isFloating={isFloating}
          isVoiceOutputTab={isVoiceOutputTab}
          onClaimVoiceOutput={onClaimVoiceOutput}
        />

        {isFloating && (
          <SatPhoneConversation
            history={history}
            scrollRef={scrollRef}
            interimTranscript={interimTranscript}
            draft={draft}
            onDraft={onDraft}
            onSend={onSend}
            onClear={onClear}
            collapsed={collapsed}
            onToggleCollapsed={onToggleCollapsed}
            conversationId={conversationId}
            inputRef={inputRef}
            images={images}
          />
        )}
      </div>
    </div>
  );
}
