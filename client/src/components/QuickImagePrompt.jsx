import { useState, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Sparkles } from 'lucide-react';

export default function QuickImagePrompt() {
  const [prompt, setPrompt] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const navigate = useNavigate();

  const handleSubmit = (e) => {
    e?.preventDefault();
    const text = prompt.trim();
    if (!text || submittingRef.current) return;

    submittingRef.current = true;
    setIsSubmitting(true);
    setPrompt('');

    // ImageGen page's remix-param effect reads ?prompt=… on mount and
    // strips it from the URL, so the widget can hand off a one-shot
    // prompt without us coupling to its internal form state.
    navigate(`/media/image?prompt=${encodeURIComponent(text)}`);
  };

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-4 h-full flex flex-col min-h-0">
      <div className="flex items-center justify-between mb-3 shrink-0">
        <h3 className="text-sm font-semibold text-white">Quick Image</h3>
        <Link to="/media/image" className="text-xs text-gray-500 hover:text-port-accent transition-colors">
          Image Gen &rarr;
        </Link>
      </div>
      <form onSubmit={handleSubmit} className="flex flex-col gap-2 flex-1 min-h-0">
        <label htmlFor="quick-image-prompt" className="sr-only">Image prompt</label>
        <textarea
          id="quick-image-prompt"
          placeholder="A neon-lit alley at dusk, cinematic, 50mm..."
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSubmit(e);
          }}
          rows={3}
          className="flex-1 min-h-0 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm resize-none"
        />
        <button
          type="submit"
          disabled={!prompt.trim() || isSubmitting}
          className="flex items-center justify-center gap-2 px-3 py-2 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg text-sm transition-colors disabled:opacity-50 min-h-[40px]"
        >
          <Sparkles size={14} />
          Generate
        </button>
      </form>
    </div>
  );
}
