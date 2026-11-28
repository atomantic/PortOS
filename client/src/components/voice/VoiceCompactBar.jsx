import { Link } from 'react-router';
import {
  ChevronDown,
  ChevronUp,
  EyeOff,
  ImagePlus,
  Infinity as InfinityIcon,
  Maximize2,
  Monitor,
  MonitorOff,
  NotebookPen,
  Radio,
  Send,
  Square,
  Trash2,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import VoiceImageChips from './VoiceImageChips';
import FilePickerButton from '../ui/FilePickerButton';
import { MicroGlyph } from '../micrographics';

// Distinct secondary-accent ring + soft glow so the floating compact pill reads
// as "voice agent layer" instead of blending into whatever card it's covering.
const FAB_SURFACE = 'border-port-accent-2/50 shadow-[0_0_24px_-4px_rgba(168,85,247,0.55)]';

const micButtonTitle = ({ handsFree, capturing, hotkey }) => {
  if (handsFree) {
    return capturing
      ? `Click or press ${hotkey} to stop hands-free listening`
      : `Click or press ${hotkey} to start hands-free listening`;
  }
  return capturing
    ? `Click or press ${hotkey} to send`
    : `Click or press ${hotkey} to listen`;
};

const micButtonAriaLabel = ({ handsFree, capturing }) => (
  handsFree
    ? (capturing ? 'Stop hands-free listening' : 'Start hands-free listening')
    : (capturing ? 'Send voice message' : 'Start listening')
);

export function DictationBanner() {
  return (
    <div role="status" className="flex items-center gap-2 bg-port-accent/15 border border-port-accent/40 rounded-full px-3 py-1 text-xs text-port-accent shadow-lg">
      <NotebookPen size={12} className="animate-pulse" />
      Dictating to Daily Log — say &quot;stop dictation&quot; to end
    </div>
  );
}

export function VoiceMobileFab({
  fabRef,
  icon: Icon,
  label,
  tone,
  capturing,
  onExpand,
  onHide,
}) {
  return (
    <div className="md:hidden flex items-center gap-2">
      <button
        type="button"
        ref={fabRef}
        // Restoring the minimized controls only reveals them: the mic stays
        // in whatever state the user left it (a stopped mic stays stopped).
        onClick={onExpand}
        className={`p-3 rounded-full border transition-colors ${FAB_SURFACE} ${
          capturing
            ? 'bg-port-accent-2 text-port-on-accent-2 animate-pulse'
            : 'bg-port-card text-port-text'
        }`}
        title="Open voice controls"
        aria-label="Open voice controls"
      >
        <Icon size={20} />
      </button>
      <button
        type="button"
        onClick={onHide}
        title="Hide voice widget (restore from the sidebar or Settings → Voice)"
        aria-label="Hide voice widget"
        className={`pointer-coarse:min-h-11 pointer-coarse:min-w-11 p-2 rounded-full bg-port-card border text-port-text-muted hover:text-port-text ${FAB_SURFACE}`}
      >
        <EyeOff size={14} />
      </button>
      {capturing && (
        <span role="status" className={`text-xs ${tone} bg-port-card/95 backdrop-blur border rounded-full px-2 py-1 ${FAB_SURFACE}`}>
          {label}
        </span>
      )}
    </div>
  );
}

export default function VoiceCompactBar({
  expanded,
  collapsed,
  conversationId,
  history,
  interimTranscript,
  scrollRef,
  inputRef,
  draft,
  onDraft,
  onSend,
  onClear,
  onToggleCollapsed,
  images,
  dictationActive,
  stage,
  icon: Icon,
  label,
  tone,
  capturing,
  continuousLive,
  level,
  hotkey,
  useWebSpeech,
  handsFree,
  visionEnabled,
  isVoiceOutputTab,
  onFullMode,
  onInterrupt,
  onToggleCapture,
  onMinimizeMobile,
  onHideWidget,
  onToggleHandsFree,
  onToggleVision,
  onClaimVoiceOutput,
}) {
  return (
    <div className={`${expanded ? 'flex' : 'hidden'} md:flex flex-col items-start gap-2 w-96 max-w-[calc(100vw-2rem)]`}>
      {!collapsed && history.length > 0 && (
        <div id={conversationId} className={`bg-port-card/95 backdrop-blur border rounded-xl w-full flex flex-col ${FAB_SURFACE}`}>
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-port-border/50">
            <span className="text-xs text-port-text-muted">Conversation</span>
            <button
              type="button"
              onClick={onClear}
              title="Clear conversation"
              aria-label="Clear conversation"
              className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 rounded text-port-text-muted hover:text-port-error hover:bg-port-error/10"
            >
              <Trash2 size={12} />
            </button>
          </div>
          <div ref={scrollRef} className="text-xs p-3 space-y-2 overflow-y-auto max-h-80">
            {/* Only finalized turns are announced; the interim line below churns per word. */}
            <div role="log" aria-live="polite" aria-label="Conversation" className="space-y-2">
              {history.map((turn, i) => (
                <div key={i} className={turn.role === 'user' ? 'text-port-text-muted' : 'text-port-text'}>
                  <span className="text-[10px] uppercase tracking-wide opacity-60 mr-2">
                    {turn.role === 'user' ? 'you' : 'assistant'}
                  </span>
                  {turn.text}
                  <VoiceImageChips images={turn.images} className="mt-1" />
                </div>
              ))}
            </div>
            {interimTranscript && (
              <div aria-hidden="true" className="text-port-text-muted italic">
                <span className="text-[10px] uppercase tracking-wide opacity-60 mr-2">you</span>
                {interimTranscript}
              </div>
            )}
          </div>
        </div>
      )}
      {images.pending.length > 0 && (
        <VoiceImageChips images={images.pending} onRemove={images.remove} className={`w-full bg-port-card/95 backdrop-blur border rounded-xl p-1.5 ${FAB_SURFACE}`} />
      )}
      <form
        onSubmit={(e) => { e.preventDefault(); onSend(); }}
        className={`flex items-center gap-1 bg-port-card/95 backdrop-blur border rounded-full pl-1 pr-1 py-1 w-full focus-within:border-port-accent ${FAB_SURFACE}`}
      >
        <FilePickerButton
          accept="image/*"
          multiple
          onChange={(e) => images.attachFiles(e.target.files)}
          ariaLabel="Attach an image for the voice assistant"
          title="Show the assistant an image"
          className="inline-flex shrink-0 cursor-pointer items-center justify-center pointer-coarse:min-h-11 pointer-coarse:min-w-11 p-2 rounded-full text-port-text-muted hover:text-port-text hover:bg-port-border/70"
        >
          <ImagePlus size={14} aria-hidden="true" />
        </FilePickerButton>
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          placeholder="Type a message…"
          aria-label="Message to the voice assistant"
          className="flex-1 bg-transparent text-sm text-port-text placeholder:text-port-text-muted focus:outline-none"
        />
        <button
          type="submit"
          disabled={!draft.trim()}
          title="Send text (Enter)"
          aria-label="Send text"
          className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 p-2 rounded-full text-port-text-muted hover:text-port-text hover:bg-port-border/70 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-port-text-muted"
        >
          <Send size={14} />
        </button>
      </form>
      {dictationActive && <DictationBanner />}
      <div className={`flex flex-col gap-1.5 bg-port-card/95 backdrop-blur border rounded-2xl p-2 w-full ${FAB_SURFACE}`}>
        <div className="flex items-center justify-between gap-1.5">
          <div className="flex items-center gap-1 min-w-0">
            <button
              type="button"
              onClick={onFullMode}
              title="Show satellite transceiver handset (saved in preferences)"
              aria-label="Show transceiver handset"
              className="satphone-key inline-flex items-center gap-1 px-2.5 py-1 rounded-full border text-[10px] pointer-coarse:min-h-11 font-mono font-semibold uppercase tracking-wider text-port-accent-text"
            >
              <Radio size={12} aria-hidden="true" />
              Handset
            </button>
            <Link
              to="/voice/call"
              title="Open full-page Voice Call station"
              aria-label="Open full-page Voice Call"
              className="inline-flex items-center justify-center p-1.5 rounded-full pointer-coarse:min-h-11 pointer-coarse:min-w-11 text-port-text-muted hover:text-port-text hover:bg-port-border/70"
            >
              <Maximize2 size={12} aria-hidden="true" />
            </Link>
            {label ? (
              <span role="status" className={`text-xs truncate ${tone}`} title={label}>{label}</span>
            ) : (
              <span role="status" className="sr-only">Standby</span>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {!useWebSpeech && handsFree && continuousLive && (
              <span
                className="inline-flex items-center text-port-accent"
                title={`mic level ${level.toFixed(3)}`}
              >
                <MicroGlyph variant="signal" size={18} level={level} state="accent" />
              </span>
            )}
            {history.length > 0 && (
              <button
                type="button"
                onClick={onToggleCollapsed}
                aria-expanded={!collapsed}
                aria-controls={conversationId}
                title={collapsed ? 'Show conversation' : 'Hide conversation'}
                aria-label={collapsed ? 'Show conversation' : 'Hide conversation'}
                className="min-h-[44px] min-w-[44px] pointer-fine:min-h-0 pointer-fine:min-w-0 inline-flex items-center justify-center p-1.5 rounded-full text-port-text-muted hover:text-port-text hover:bg-port-border/70"
              >
                {collapsed ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              </button>
            )}
            {stage === 'speaking' && (
              <button
                type="button"
                onClick={onInterrupt}
                title="Interrupt"
                aria-label="Interrupt"
                className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 p-2 rounded-full text-port-error hover:bg-port-error/10"
              >
                <Square size={14} />
              </button>
            )}
            <button
              type="button"
              onClick={onToggleCapture}
              aria-pressed={capturing}
              className={`pointer-coarse:min-h-11 pointer-coarse:min-w-11 p-2 rounded-full transition-colors ${
                capturing
                  ? 'bg-port-accent-2 text-port-on-accent-2 animate-pulse'
                  : 'bg-port-accent-2/20 hover:bg-port-accent-2/40 text-port-accent-2'
              }`}
              title={micButtonTitle({ handsFree, capturing, hotkey })}
              aria-label={micButtonAriaLabel({ handsFree, capturing })}
            >
              <Icon size={15} />
            </button>
            <button
              type="button"
              onClick={onMinimizeMobile}
              title="Minimize voice controls"
              aria-label="Minimize voice controls"
              className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 md:hidden p-1.5 rounded-full text-port-text-muted hover:text-port-text hover:bg-port-border/70"
            >
              <X size={14} />
            </button>
            <button
              type="button"
              onClick={onHideWidget}
              title="Hide voice widget (restore from the sidebar or Settings → Voice)"
              aria-label="Hide voice widget"
              className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 p-1.5 rounded-full text-port-text-muted hover:text-port-text hover:bg-port-border/70"
            >
              <EyeOff size={14} />
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1 border-t border-port-border/50 pt-1.5">
          {!useWebSpeech && (
            <button
              type="button"
              onClick={onToggleHandsFree}
              aria-pressed={handsFree}
              title={handsFree
                ? 'Hands-free ON — mic stays open, auto-submits on pause, talk over the bot to interrupt. Click to switch to push-to-talk.'
                : 'Push-to-talk ON — click mic to start, click again to send. Click to switch to hands-free.'}
              className={`flex items-center gap-1 px-2 py-1 rounded-full text-[10px] pointer-coarse:min-h-11 font-medium ${handsFree
                ? 'text-port-accent-text bg-port-accent/10 hover:bg-port-accent/20'
                : 'text-port-text-muted hover:text-port-text hover:bg-port-border/70'}`}
            >
              <InfinityIcon size={12} />
              {handsFree ? 'hands-free' : 'push-to-talk'}
            </button>
          )}
          <button
            type="button"
            onClick={onToggleVision}
            aria-label={visionEnabled ? 'Disable screen vision for voice' : 'Enable screen vision for voice'}
            aria-pressed={visionEnabled}
            title={visionEnabled
              ? 'Screen vision ON — the assistant can describe what\'s on your screen ("what\'s on this chart?"). Click to stop sharing.'
              : 'Screen vision OFF — click to let the assistant see your screen for "what\'s on this chart?" (you pick the tab/window).'}
            className={`flex items-center gap-1 px-2 py-1 rounded-full text-[10px] pointer-coarse:min-h-11 font-medium ${visionEnabled
              ? 'text-port-accent-text bg-port-accent/10 hover:bg-port-accent/20'
              : 'text-port-text-muted hover:text-port-text hover:bg-port-border/70'}`}
          >
            {visionEnabled ? <Monitor size={12} /> : <MonitorOff size={12} />}
            {visionEnabled ? 'vision' : 'no vision'}
          </button>
          <button
            type="button"
            onClick={onClaimVoiceOutput}
            aria-pressed={isVoiceOutputTab}
            title={isVoiceOutputTab
              ? 'This tab plays the assistant\'s proactive speech (reminders, briefings). Only one tab speaks at a time.'
              : 'Proactive speech plays on another tab. Click to make this tab the speaker.'}
            className={`flex items-center gap-1 px-2 py-1 rounded-full text-[10px] pointer-coarse:min-h-11 font-medium ${isVoiceOutputTab
              ? 'text-port-success-text bg-port-success/10'
              : 'text-port-text-muted hover:text-port-text hover:bg-port-border/70'}`}
          >
            {isVoiceOutputTab ? <Volume2 size={12} /> : <VolumeX size={12} />}
            {isVoiceOutputTab ? 'speaker' : 'muted'}
          </button>
        </div>
      </div>
    </div>
  );
}
