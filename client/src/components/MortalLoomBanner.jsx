import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { X, ExternalLink, Smartphone } from 'lucide-react';

const APP_STORE_URL = 'https://apps.apple.com/app/id6760883701';
const DISMISS_KEY = 'mortalloom-banner-dismissed-v1';

export default function MortalLoomBanner({ section = 'this data' }) {
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    const v = typeof window !== 'undefined' ? window.localStorage.getItem(DISMISS_KEY) : '1';
    setDismissed(v === '1');
  }, []);

  const handleDismiss = () => {
    window.localStorage.setItem(DISMISS_KEY, '1');
    setDismissed(true);
  };

  if (dismissed) return null;

  return (
    <div className="mx-4 sm:mx-6 mt-3 mb-1 rounded-xl border border-port-accent/30 bg-gradient-to-r from-port-accent/10 to-port-accent/5 px-4 py-3 flex items-start gap-3">
      <div className="shrink-0 w-8 h-8 rounded-lg bg-port-accent/20 flex items-center justify-center">
        <Smartphone size={16} className="text-port-accent" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-white font-medium">
          {section} is now available in the MortalLoom app
        </p>
        <p className="text-xs text-gray-400 mt-0.5">
          Manage your longevity data natively on iPhone, iPad, and Mac — synced privately via iCloud.
        </p>
        <div className="flex items-center gap-3 mt-2">
          <a
            href={APP_STORE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs px-3 py-1 bg-port-accent text-white rounded-lg hover:bg-port-accent/80 transition-colors"
          >
            Install on App Store
            <ExternalLink size={10} />
          </a>
          <Link
            to="/settings/mortalloom"
            className="text-xs text-gray-400 hover:text-white transition-colors"
          >
            Configure iCloud sync →
          </Link>
        </div>
      </div>
      <button
        onClick={handleDismiss}
        className="shrink-0 text-gray-500 hover:text-white transition-colors"
        aria-label="Dismiss"
      >
        <X size={16} />
      </button>
    </div>
  );
}
