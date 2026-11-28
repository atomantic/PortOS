import { useState } from 'react';
import { Radio, Send, Settings2, Trash2 } from 'lucide-react';
import AvatarChannelsPanel from './AvatarChannelsPanel';
import AvatarRuntimeSettings from './AvatarRuntimeSettings';
import SatPhoneHandset from './SatPhoneHandset';
import VoiceLlmQuickPicker from './VoiceLlmQuickPicker';
import { useAvatarRuntime } from './useAvatarRuntime';

function StationTelemetry({
  voiceLabel,
  canChangeMicMode,
  handsFree,
  volume,
  muted,
  runningAvatar,
  showAvatarSettings,
  onToggleAvatarSettings,
}) {
  const captureMode = !canChangeMicMode ? 'Web Speech' : handsFree ? 'Hands-free (VOX)' : 'Push-to-talk';
  const avatarStatus = runningAvatar ? 'AvatarForcing live' : 'Still portrait';

  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
      <div className="rounded-xl border border-port-border bg-port-card px-3 py-2.5 min-w-0">
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-port-text-muted">Voice profile</p>
        <p className="mt-0.5 truncate font-mono text-xs font-semibold text-port-text" title={voiceLabel || 'Saved settings'}>
          {voiceLabel || 'Saved settings'}
        </p>
      </div>
      <div className="rounded-xl border border-port-border bg-port-card px-3 py-2.5 min-w-0">
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-port-text-muted">Audio link</p>
        <p className="mt-0.5 truncate font-mono text-xs font-semibold text-port-text" title={`${captureMode} · ${muted ? 'Muted' : `${Math.round(volume * 100)}%`}`}>
          {captureMode} · {muted ? 'Muted' : `${Math.round(volume * 100)}%`}
        </p>
      </div>
      <div className="flex items-center justify-between gap-2 rounded-xl border border-port-border bg-port-card px-3 py-2.5 min-w-0">
        <div className="min-w-0">
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-port-text-muted">Video feed</p>
          <p className="mt-0.5 flex items-center gap-1.5 font-mono text-xs font-semibold text-port-text">
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                runningAvatar ? 'bg-port-accent shadow-[0_0_6px_rgb(var(--port-accent))]' : 'bg-port-success'
              }`}
            />
            <span className="truncate" title={avatarStatus}>{avatarStatus}</span>
          </p>
        </div>
        {runningAvatar && (
          <button
            type="button"
            onClick={onToggleAvatarSettings}
            aria-expanded={showAvatarSettings}
            aria-label="Avatar settings"
            title={showAvatarSettings ? 'Hide avatar settings' : 'Avatar settings'}
            className={`inline-flex shrink-0 items-center justify-center rounded-lg border p-1.5 pointer-coarse:min-h-11 pointer-coarse:min-w-11 transition-colors ${
              showAvatarSettings
                ? 'border-port-accent bg-port-accent/10 text-port-accent-text'
                : 'border-port-border bg-port-bg text-port-text-muted hover:border-port-accent hover:text-port-text'
            }`}
          >
            <Settings2 size={15} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}

export default function VoiceCallConsole({
  stage, history, scrollRef, interimTranscript, capturing, handsFree, canChangeMicMode,
  hotkey, draft, onDraft, onSend, onMic, onMode, onInterrupt, onEnd, onClear,
  voiceLabel, llmProvider, llmModel, onLlmSaved, volume = 0.85, muted = false, onVolumeChange, onToggleMute,
  sfxEnabled = true, onToggleSfx, signalLevel = 0, visionEnabled = false, onToggleVision,
}) {
  const [showAvatarSettings, setShowAvatarSettings] = useState(false);
  const { data, error, updateData, refetch } = useAvatarRuntime();
  const runningAvatar = Boolean(!error && data?.supported && data.phase === 'running');

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
        />
      </div>

      {/* Right column: Tactical Station Bay (Telemetry + Avatar Engine + Transmission Log & Composer) */}
      <div className="flex min-w-0 flex-col gap-4">
        <StationTelemetry
          voiceLabel={voiceLabel}
          canChangeMicMode={canChangeMicMode}
          handsFree={handsFree}
          volume={volume}
          muted={muted}
          runningAvatar={runningAvatar}
          showAvatarSettings={showAvatarSettings}
          onToggleAvatarSettings={() => setShowAvatarSettings((prev) => !prev)}
        />

        <AvatarRuntimeSettings
          data={data}
          error={error}
          updateData={updateData}
          refetch={refetch}
          open={showAvatarSettings}
          onToggleOpen={setShowAvatarSettings}
        />

        <VoiceLlmQuickPicker
          provider={llmProvider}
          model={llmModel}
          onSaved={onLlmSaved}
        />

        {/* Dedicated full-height Transmission Log & Message Composer */}
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
                  Channel quiet. Press the TALK paddle on the handset or transmit a message below.
                </p>
              )}
              {history.map((turn, i) => (
                <p key={i} className={turn.role === 'user' ? 'opacity-80' : ''}>
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
                </p>
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

          <form
            className="flex min-w-0 flex-wrap gap-2 sm:flex-nowrap"
            onSubmit={(event) => { event.preventDefault(); onSend(); }}
          >
            <input
              type="text"
              aria-label="Message to the voice assistant"
              value={draft}
              onChange={(event) => onDraft(event.target.value)}
              placeholder="Transmit a message…"
              className="min-h-11 min-w-0 flex-1 rounded-xl border border-port-border bg-port-bg px-3.5 font-mono text-sm text-port-text placeholder:text-port-text-muted focus:border-port-accent focus:outline-none"
            />
            <button
              type="submit"
              disabled={!draft.trim()}
              className="satphone-key inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-xl border px-4 font-mono text-xs font-semibold uppercase tracking-wider text-port-accent-text disabled:opacity-45"
            >
              <Send size={14} aria-hidden="true" />
              Send
            </button>
          </form>
        </section>

        <AvatarChannelsPanel />
      </div>
    </section>
  );
}
