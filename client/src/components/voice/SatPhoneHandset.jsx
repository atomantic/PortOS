import { useState } from 'react';
import { SatPhoneFaceplate, SatPhoneSetup, SatPhoneSpeaker } from './SatPhoneFaceplate';
import SatPhoneViewfinder from './SatPhoneViewfinder';
import { SatPhoneActionKeys, SatPhoneTalkPaddle, SatPhoneTelemetry } from './SatPhoneControls';
import SatPhoneConversation from './SatPhoneConversation';

/**
 * Video-enabled Satellite Phone / Tactical Transceiver Handset.
 *
 * Shared between the bottom-left floating voice agent (`variant="floating"`)
 * and the dedicated full-page Voice Call station (`variant="page"`). Every
 * indicator, dial, paddle, and key maps to real voice/audio functionality.
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
  onSample,
  onClear,
  voiceLabel,
  llmProvider,
  llmModel,
  onLlmSaved,
  avatar,
  onToggleAvatar,
  avatarData,
  avatarError,
  onUpdateAvatarData,
  onRefetchAvatar,
  runningAvatar,
  volume,
  muted,
  onVolumeChange,
  onToggleMute,
  sfxEnabled,
  onToggleSfx,
  signalLevel = 0,
  visionEnabled = false,
  onToggleVision,
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
  const [showFloatingAvatarSetup, setShowFloatingAvatarSetup] = useState(false);
  const isFloating = variant === 'floating';
  const caption = interimTranscript || history.at(-1)?.text;
  const liveAttr = capturing ? 'tx' : (stage === 'speaking' || stage === 'thinking') ? 'rx' : 'idle';

  return (
    <div className={`relative flex flex-col ${isFloating ? 'w-[21.25rem] max-w-[calc(100vw-2rem)]' : 'w-full'}`}>
      {/* Sculpted top-right satellite antenna assembly */}
      <div className="flex justify-end pr-6 -mb-[2px] pointer-events-none select-none" aria-hidden="true">
        <div className="relative flex flex-col items-center">
          <div className="satphone-antenna relative h-5 w-4 rounded-t-md border border-b-0">
            <span
              className={`absolute left-1/2 top-1 h-1 w-1.5 -translate-x-1/2 rounded-full transition-colors ${
                capturing
                  ? 'bg-port-accent-2 shadow-[0_0_6px_rgb(var(--port-accent-2))]'
                  : stage === 'speaking'
                    ? 'bg-port-accent shadow-[0_0_6px_rgb(var(--port-accent))]'
                    : 'bg-port-border'
              }`}
            />
          </div>
          <div className="h-1.5 w-6 rounded-t-sm border border-b-0 border-port-border bg-port-bg" />
        </div>
      </div>

      {/* Main machined transceiver chassis */}
      <div
        data-live={liveAttr}
        className={`satphone-chassis relative flex flex-col rounded-2xl border text-port-text ${
          isFloating ? 'gap-2 p-2.5 max-h-[calc(100dvh-3.5rem)] overflow-y-auto' : 'gap-2.5 p-3 sm:p-3.5'
        }`}
      >
        <SatPhoneFaceplate
          isFloating={isFloating}
          stage={stage}
          capturing={capturing}
          avatar={avatar}
          runningAvatar={runningAvatar}
          avatarData={avatarData}
          showAvatarSetup={showFloatingAvatarSetup}
          onToggleAvatarSetup={() => setShowFloatingAvatarSetup((value) => !value)}
          onCompactMode={onCompactMode}
          onMinimizeMobile={onMinimizeMobile}
          onHideWidget={onHideWidget}
        />

        {isFloating && showFloatingAvatarSetup && (
          <SatPhoneSetup
            llmProvider={llmProvider}
            llmModel={llmModel}
            onLlmSaved={onLlmSaved}
            avatarData={avatarData}
            avatarError={avatarError}
            onUpdateAvatarData={onUpdateAvatarData}
            onRefetchAvatar={onRefetchAvatar}
          />
        )}

        <div className="flex items-stretch gap-1.5 min-w-0">
          <SatPhoneViewfinder
            avatar={avatar}
            runningAvatar={runningAvatar}
            stage={stage}
            capturing={capturing}
            caption={caption}
          />
          <SatPhoneTalkPaddle
            isFloating={isFloating}
            capturing={capturing}
            handsFree={handsFree}
            canChangeMicMode={canChangeMicMode}
            hotkey={hotkey}
            onMic={onMic}
          />
        </div>

        <SatPhoneTelemetry
          isFloating={isFloating}
          stage={stage}
          handsFree={handsFree}
          canChangeMicMode={canChangeMicMode}
          onMode={onMode}
          onSample={onSample}
          avatar={avatar}
          onToggleAvatar={onToggleAvatar}
          volume={volume}
          muted={muted}
          voiceLabel={voiceLabel}
          llmProvider={llmProvider}
          llmModel={llmModel}
          signalLevel={signalLevel}
          onVolumeChange={onVolumeChange}
          onToggleMute={onToggleMute}
        />

        <SatPhoneActionKeys
          stage={stage}
          sfxEnabled={sfxEnabled}
          onToggleSfx={onToggleSfx}
          muted={muted}
          onToggleMute={onToggleMute}
          visionEnabled={visionEnabled}
          onToggleVision={onToggleVision}
          onSample={onSample}
          onInterrupt={onInterrupt}
          onEnd={onEnd}
        />

        <SatPhoneSpeaker
          isFloating={isFloating}
          isVoiceOutputTab={isVoiceOutputTab}
          onClaimVoiceOutput={onClaimVoiceOutput}
        />

        {isFloating && (
          <SatPhoneConversation
            stage={stage}
            history={history}
            scrollRef={scrollRef}
            interimTranscript={interimTranscript}
            draft={draft}
            onDraft={onDraft}
            onSend={onSend}
            onSample={onSample}
            onClear={onClear}
            collapsed={collapsed}
            onToggleCollapsed={onToggleCollapsed}
            conversationId={conversationId}
            inputRef={inputRef}
          />
        )}
      </div>
    </div>
  );
}
