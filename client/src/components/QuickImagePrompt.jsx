import { useState, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Sparkles, Pencil } from 'lucide-react';
import { generateImage } from '../services/api';
import { DEFAULT_NEGATIVE_PROMPT } from '../lib/imageGenDefaults';
import toast from './ui/Toast';

export default function QuickImagePrompt() {
  const [prompt, setPrompt] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const navigate = useNavigate();

  const handleGenerate = async (e) => {
    e?.preventDefault();
    const text = prompt.trim();
    if (!text || submittingRef.current) return;

    submittingRef.current = true;
    setIsSubmitting(true);

    // Omit `mode` so the server falls back to the user's saved
    // `settings.imageGen.mode` default. Async backends (local/codex) respond
    // with { jobId, status, position } — sync external responds with the
    // generation result. Toast wording covers both cases without inspecting
    // backend internals. Preserve the input on failure so the user doesn't
    // have to retype after a server error (the API helper toasts on its own).
    const result = await generateImage({
      prompt: text,
      negativePrompt: DEFAULT_NEGATIVE_PROMPT,
    }).catch(() => null);

    submittingRef.current = false;
    setIsSubmitting(false);
    if (result) {
      // Only clear if the textarea still holds the submitted text — the user
      // can keep typing while the request is in flight and we don't want to
      // wipe out new input on resolve.
      setPrompt((current) => (current === text ? '' : current));
      toast.success(result.status === 'queued' || result.status === 'running' ? 'Image queued' : 'Image generated');
    }
  };

  const handleOpenInEditor = (e) => {
    e?.preventDefault();
    const text = prompt.trim();
    // ImageGen page's remix-param effect reads ?prompt=… on mount and strips
    // it from the URL, so the widget can hand off a one-shot prompt without
    // coupling to the form's internal state.
    navigate(`/media/image${text ? `?prompt=${encodeURIComponent(text)}` : ''}`);
  };

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-4 h-full flex flex-col min-h-0">
      <div className="flex items-center justify-between mb-3 shrink-0">
        <h3 className="text-sm font-semibold text-white">Quick Image</h3>
        <Link to="/media/image" className="text-xs text-gray-500 hover:text-port-accent transition-colors">
          Image Gen &rarr;
        </Link>
      </div>
      <form onSubmit={handleGenerate} className="flex flex-col gap-2 flex-1 min-h-0">
        <label htmlFor="quick-image-prompt" className="sr-only">Image prompt</label>
        <textarea
          id="quick-image-prompt"
          placeholder="A neon-lit alley at dusk, cinematic, 50mm..."
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleGenerate(e);
          }}
          rows={3}
          className="flex-1 min-h-0 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm resize-none"
        />
        <div className="flex items-center gap-2">
          <button
            type="submit"
            disabled={!prompt.trim() || isSubmitting}
            className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg text-sm transition-colors disabled:opacity-50 min-h-[40px]"
            title="Generate with default settings"
          >
            <Sparkles size={14} />
            {isSubmitting ? 'Submitting…' : 'Generate'}
          </button>
          <button
            type="button"
            onClick={handleOpenInEditor}
            disabled={isSubmitting}
            className="flex items-center justify-center gap-2 px-3 py-2 border border-port-border text-gray-300 hover:text-white hover:bg-port-border/50 rounded-lg text-sm transition-colors disabled:opacity-50 min-h-[40px]"
            title="Open in editor with this prompt"
          >
            <Pencil size={14} />
            Edit
          </button>
        </div>
      </form>
    </div>
  );
}
