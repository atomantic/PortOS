import { useState, useMemo, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Send } from 'lucide-react';
import toast from './ui/Toast';
import * as api from '../services/api';

const URL_PATTERN = /^(https?:\/\/|git@)/i;
const DOMAIN_PATTERN = /^\S+\.\S+$/;

export default function QuickBrainCapture() {
  const [input, setInput] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const isUrl = useMemo(() => {
    const trimmed = input.trim();
    if (!trimmed) return false;
    return URL_PATTERN.test(trimmed) || DOMAIN_PATTERN.test(trimmed);
  }, [input]);

  const handleSubmit = async (e) => {
    e?.preventDefault();
    const text = input.trim();
    if (!text || submittingRef.current) return;

    // Synchronous ref lock prevents duplicate requests from rapid clicks/Enter
    submittingRef.current = true;
    setIsSubmitting(true);
    // Clear input immediately so user can keep typing
    setInput('');

    if (isUrl) {
      let url = text;
      if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('git@')) {
        url = 'https://' + url;
      }
      const result = await api.createBrainLink({ url }).catch(err => {
        if (err.message?.includes('already exists')) {
          toast.error('This URL is already saved');
        } else {
          toast.error(err.message || 'Failed to save link');
        }
        setInput(prev => prev || text);
        return null;
      });
      if (result) {
        toast.success(result.isGitHubRepo ? 'GitHub repo added' : 'Link saved');
      }
    } else {
      const result = await api.captureBrainThought(text).catch(err => {
        toast.error(err.message || 'Failed to capture thought');
        setInput(prev => prev || text);
        return null;
      });
      if (result) {
        toast.success(result.message || 'Thought captured');
      }
    }
    submittingRef.current = false;
    setIsSubmitting(false);
  };

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
          type="text"
          placeholder="Thought, URL, or link..."
          value={input}
          onChange={e => setInput(e.target.value)}
          className="flex-1 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
        />
        <button
          type="submit"
          disabled={!input.trim() || isSubmitting}
          className="flex items-center gap-1 px-3 py-2 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg text-sm transition-colors disabled:opacity-50 min-h-[40px]"
        >
          <Send size={14} />
        </button>
      </form>
      {input.trim() && (
        <p className="mt-2 text-xs text-gray-500">
          {isUrl ? 'Will save as link' : 'Will capture as thought'}
        </p>
      )}
    </div>
  );
}
