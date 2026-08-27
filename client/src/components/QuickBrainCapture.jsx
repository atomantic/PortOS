import { useState, useMemo, useRef, useEffect } from 'react';
import { Link } from 'react-router';
import { ChevronDown, ClipboardPaste, Film, Send, Sliders, Sparkles, X } from 'lucide-react';
import toast from './ui/Toast';
import * as api from '../services/api';
import { useLocalStorageBool, useRepoIntake, useYoutubeIngest } from '../hooks';
import { parseBareUrl } from '../lib/bareUrl';
import { readClipboard } from '../lib/clipboard';
import { INGEST_OPTIONS, defaultIngestOptions, ingestOptionsFromSettings, isYoutubeVideoUrl } from '../lib/youtubeUrl';
import RepoIntakeOptions from './brain/RepoIntakeOptions';
import ToggleChip from './ui/ToggleChip';

export default function QuickBrainCapture() {
  const [input, setInput] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const inputRef = useRef(null);
  // Sticky "Creative" flag (shared key with the Inbox capture toggle) so a
  // creative thought captured here is flagged for the catalog the same way.
  const [creative, setCreative] = useLocalStorageBool('brain.captureCreative', false);

  // Mirrors the server's filing rule (client/src/lib/bareUrl.js) so the hint and
  // the Creative lockout match where the capture actually lands.
  const isUrl = useMemo(() => !!parseBareUrl(input), [input]);
  // A single-video YouTube URL takes a different path entirely (ingest, not
  // capture) and unlocks the advanced panel below.
  const isYoutube = useMemo(() => isYoutubeVideoUrl(input), [input]);
  // A bare GitHub repo URL is cloned on capture, which unlocks the two post-clone
  // agent opt-ins (malware scan / repo study).
  const repoIntake = useRepoIntake(input);

  const [showAdvanced, setShowAdvanced] = useState(false);
  const [ingestOpts, setIngestOpts] = useState(defaultIngestOptions);
  const [agentPrompt, setAgentPrompt] = useState('');
  const [tagsInput, setTagsInput] = useState('');

  // Server-side defaults for the checkboxes, so a user who always wants audio
  // sets it once in settings instead of every capture.
  //
  // Fetched as soon as a YouTube URL is in the box — NOT when the panel opens.
  // The panel is optional: the common path is paste-and-send without ever
  // expanding it, and seeding only on open meant those saved defaults never
  // governed the submit that actually matters (a configured "always download
  // audio" silently sent transcript-only). Still lazy enough that a dashboard
  // showing this widget pays nothing until a YouTube link is typed.
  const seededRef = useRef(false);
  useEffect(() => {
    if (!isYoutube || seededRef.current) return;
    seededRef.current = true;
    api.getYoutubeIngestSettings({ silent: true })
      .then((settings) => setIngestOpts(ingestOptionsFromSettings(settings)))
      .catch(() => {}); // defaultIngestOptions() is already sensible
  }, [isYoutube]);

  const ingest = useYoutubeIngest({
    onComplete: () => {
      setAgentPrompt('');
      setTagsInput('');
    },
  });

  const nothingSelected = !INGEST_OPTIONS.some((o) => ingestOpts[o.key]);

  const handleSubmit = async (e) => {
    e?.preventDefault();
    const text = input.trim();
    if (!text || submittingRef.current) return;

    if (isYoutube) {
      if (nothingSelected) {
        toast.error('Pick at least one of transcript, video, or audio');
        return;
      }
      // The ingest job is long-running and streams its own progress/toasts, so
      // the input clears immediately and the widget stays usable.
      setInput('');
      ingest.start({
        url: text,
        ...ingestOpts,
        agentPrompt: agentPrompt.trim(),
        tags: tagsInput.split(',').map((t) => t.trim()).filter(Boolean),
      });
      return;
    }

    // Synchronous ref lock prevents duplicate requests from rapid clicks/Enter
    submittingRef.current = true;
    setIsSubmitting(true);
    // Clear input immediately so user can keep typing
    setInput('');

    // Everything goes through capture — the server files a text that is nothing
    // but a URL straight to Links (re-pasting a saved URL reuses it instead of
    // erroring), so this surface doesn't need its own link-vs-thought branch.
    // It ignores the sticky Creative flag for a URL; dropping it here too keeps
    // the request honest about what will be stored.
    // `intakeFor` re-derives from the submitted text, so a sticky tick can't ride
    // along on a capture that is no longer a repo URL.
    const result = await api.captureBrainThought(text, undefined, undefined, {
      creative: creative && !isUrl,
      repoIntake: repoIntake.intakeFor(text),
    }, { silent: true }).catch(err => {
      toast.error(err.message || 'Failed to capture');
      setInput(prev => prev || text);
      return null;
    });
    if (result) {
      toast.success(result.message || 'Captured');
      repoIntake.setStudyContext('');
    }
    submittingRef.current = false;
    setIsSubmitting(false);
  };

  // Paste without having to click into the box first — the usual flow here is
  // "copy a link somewhere else, come back, capture". Clipboard text replaces the
  // field: this widget captures one item at a time and clears itself on submit.
  const handlePaste = async () => {
    const text = await readClipboard();
    // null = clipboard unreadable (insecure origin, denied permission); '' = an
    // empty clipboard. Different problems, different fixes for the user.
    if (text === null) {
      toast.error('Clipboard unavailable — paste into the box instead');
      inputRef.current?.focus();
      return;
    }
    const trimmed = text.trim();
    if (!trimmed) {
      toast.error('Clipboard is empty');
      return;
    }
    setInput(trimmed);
    inputRef.current?.focus();
  };

  const toggleOption = (key) => setIngestOpts((prev) => ({ ...prev, [key]: !prev[key] }));

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-white">Quick Capture</h3>
        <Link to="/brain/inbox" className="text-xs text-gray-500 hover:text-port-accent transition-colors">
          Brain &rarr;
        </Link>
      </div>
      <form onSubmit={handleSubmit} className="flex gap-2">
        <label htmlFor="quick-brain-input" className="sr-only">Capture a thought or URL</label>
        <input
          id="quick-brain-input"
          ref={inputRef}
          type="text"
          placeholder="Thought, URL, or YouTube link..."
          value={input}
          onChange={e => setInput(e.target.value)}
          className="flex-1 min-w-0 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
        />
        <button
          type="button"
          onClick={handlePaste}
          aria-label="Paste from clipboard"
          title="Paste from clipboard"
          className="flex items-center px-2.5 py-2 rounded-lg border border-port-border bg-port-bg text-gray-400 hover:text-gray-200 text-sm transition-colors min-h-[40px]"
        >
          <ClipboardPaste size={14} />
        </button>
        {isYoutube ? (
          <button
            type="button"
            onClick={() => setShowAdvanced(v => !v)}
            aria-expanded={showAdvanced}
            aria-controls="quick-brain-advanced"
            aria-label="Toggle ingest options"
            className={`flex items-center px-2.5 py-2 rounded-lg border text-sm transition-colors min-h-[40px] ${showAdvanced
              ? 'bg-red-500/20 text-red-300 border-red-500/40'
              : 'bg-port-bg text-gray-400 border-port-border hover:text-gray-200'}`}
            title="YouTube ingest options"
          >
            <Sliders size={14} />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setCreative(v => !v)}
            aria-pressed={creative}
            aria-label="Toggle creative capture mode"
            disabled={isUrl}
            className={`flex items-center px-2.5 py-2 rounded-lg border text-sm transition-colors min-h-[40px] disabled:opacity-40 disabled:cursor-not-allowed ${creative
              ? 'bg-purple-500/20 text-purple-300 border-purple-500/40'
              : 'bg-port-bg text-gray-400 border-port-border hover:text-gray-200'}`}
            title={isUrl ? 'URLs are saved as links, not creative ideas' : 'Creative mode: flag this thought for the Catalog'}
          >
            <Sparkles size={14} />
          </button>
        )}
        <button
          type="submit"
          disabled={!input.trim() || isSubmitting || ingest.active}
          aria-label="Capture"
          className="flex items-center gap-1 px-3 py-2 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg text-sm transition-colors disabled:opacity-50 min-h-[40px]"
        >
          <Send size={14} />
        </button>
      </form>

      {isYoutube && showAdvanced && (
        <div id="quick-brain-advanced" className="mt-3 pt-3 border-t border-port-border space-y-3">
          <div className="flex flex-wrap gap-2">
            {INGEST_OPTIONS.map(({ key, label, hint }) => (
              <ToggleChip
                key={key}
                id={`quick-brain-${key}`}
                label={label}
                hint={hint}
                checked={ingestOpts[key]}
                onToggle={() => toggleOption(key)}
              />
            ))}
          </div>

          <div>
            <label htmlFor="quick-brain-prompt" className="block text-xs text-gray-400 mb-1">
              What should an agent do with this? <span className="text-gray-600">(optional — queues a CoS task)</span>
            </label>
            <textarea
              id="quick-brain-prompt"
              rows={3}
              value={agentPrompt}
              onChange={e => setAgentPrompt(e.target.value)}
              placeholder="e.g. Review for features and improvements to our writing tools; file issues for anything actionable."
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
            />
          </div>

          <div>
            <label htmlFor="quick-brain-tags" className="block text-xs text-gray-400 mb-1">
              Tags <span className="text-gray-600">(comma separated)</span>
            </label>
            <input
              id="quick-brain-tags"
              type="text"
              value={tagsInput}
              onChange={e => setTagsInput(e.target.value)}
              placeholder="writing-tools, research"
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
            />
          </div>
        </div>
      )}

      <RepoIntakeOptions
        idPrefix="quick-brain-repo"
        repo={repoIntake.repo}
        options={repoIntake.options}
        managedApps={repoIntake.managedApps}
        targetAppId={repoIntake.targetAppId}
        onTargetAppChange={repoIntake.setTargetAppId}
        studyContext={repoIntake.studyContext}
        onStudyContextChange={repoIntake.setStudyContext}
        providerOverride={repoIntake.providerOverride}
        providers={repoIntake.providers}
        activeProviderId={repoIntake.activeProviderId}
        onProviderOverrideChange={repoIntake.setProviderOverride}
        onToggle={repoIntake.toggle}
      />

      {ingest.active && (
        <div className="mt-3 flex items-center gap-2 text-xs text-gray-400">
          <Film size={14} className="text-red-400 shrink-0" />
          <span aria-live="polite" className="capitalize">{ingest.stage || 'starting'}…</span>
          <div
            role="progressbar"
            aria-label="YouTube video ingest progress"
            aria-valuenow={Math.round(ingest.percent)}
            aria-valuemin={0}
            aria-valuemax={100}
            className="flex-1 h-1.5 bg-port-bg rounded-full overflow-hidden"
          >
            <div className="h-full bg-port-accent transition-all" style={{ width: `${ingest.percent}%` }} />
          </div>
          <button
            type="button"
            onClick={ingest.cancel}
            aria-label="Cancel ingest"
            className="text-gray-500 hover:text-red-400 transition-colors"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {input.trim() && !ingest.active && (
        <p className="mt-2 text-xs text-gray-500">
          {isYoutube ? (
            <button
              type="button"
              onClick={() => setShowAdvanced(v => !v)}
              className="inline-flex items-center gap-1 hover:text-gray-300 transition-colors"
            >
              Will ingest {INGEST_OPTIONS.filter(o => ingestOpts[o.key]).map(o => o.label.toLowerCase()).join(' + ') || 'nothing — pick an option'}
              <ChevronDown size={12} className={showAdvanced ? 'rotate-180 transition-transform' : 'transition-transform'} />
            </button>
          ) : repoIntake.repo ? 'Will save as link and clone the repo' : isUrl ? 'Will save as link' : creative ? 'Will capture as a creative thought' : 'Will capture as thought'}
        </p>
      )}
    </div>
  );
}
