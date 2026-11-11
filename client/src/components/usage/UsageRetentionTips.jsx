import { useEffect, useState } from 'react';
import { Copy, Lightbulb } from 'lucide-react';
import * as api from '../../services/api';
import Banner from '../ui/Banner';
import { copyToClipboard } from '../../lib/clipboard';

const buttonClass = 'inline-flex min-h-11 items-center gap-1 rounded-lg border border-port-border px-3 text-port-text hover:border-port-accent disabled:opacity-50';

// One-line CLI settings that keep session history on disk, hidden once the
// server sees them applied or the user says they're done. PortOS never edits
// the CLI's config itself.
export default function UsageRetentionTips() {
  const [tips, setTips] = useState([]);
  const [dismissing, setDismissing] = useState(null);

  useEffect(() => {
    let live = true;
    api.getUsageTips({ silent: true })
      .then((res) => { if (live) setTips(res?.tips || []); })
      .catch(() => {});
    return () => { live = false; };
  }, []);

  const dismiss = (id) => {
    setDismissing(id);
    api.dismissUsageTip(id)
      .then((res) => setTips(res?.tips || []))
      .catch(() => {})
      .finally(() => setDismissing(null));
  };

  if (!tips.length) return null;
  return (
    <div className="space-y-2">
      {tips.map((tip) => (
        <Banner key={tip.id} tone="info" icon={Lightbulb} title={tip.label}>
          <p className="mt-1 text-gray-300">
            {tip.text} Add this to <code className="break-all">{tip.file}</code>:
          </p>
          <code className="mt-2 block break-all rounded bg-port-bg px-2 py-1 text-port-text">{tip.snippet}</code>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button type="button" className={buttonClass} onClick={() => copyToClipboard(tip.snippet, 'Setting copied')}>
              <Copy size={14} aria-hidden="true" /> Copy
            </button>
            <button type="button" className={buttonClass} disabled={dismissing === tip.id} onClick={() => dismiss(tip.id)}>
              I've added it
            </button>
            {tip.docsUrl && <a className="inline-flex min-h-11 items-center px-1 underline" href={tip.docsUrl} target="_blank" rel="noreferrer">Docs</a>}
          </div>
        </Banner>
      ))}
    </div>
  );
}
