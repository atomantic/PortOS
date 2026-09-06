import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { ExternalLink } from 'lucide-react';
import BrailleSpinner from '../BrailleSpinner';
import { getCredentialInventory } from '../../services/api';

const SOURCE_LABEL = {
  settings: 'Settings',
  'env-file': '.env',
  env: 'Configured externally',
  cli: 'CLI / keychain',
  config: 'Instance config',
  none: 'Not configured',
};

const TIER_LABEL = {
  free: 'Free',
  metered: 'Metered',
  none: 'No key',
};

export function CredentialsTab() {
  const [payload, setPayload] = useState(null);
  const [error, setError] = useState(null);

  const load = () => {
    setError(null);
    getCredentialInventory({ silent: true })
      .then((data) => {
        setPayload(data);
      })
      .catch((err) => {
        setError(err);
      });
  };

  useEffect(() => {
    load();
  }, []);

  if (error) {
    return (
      <div className="space-y-3 max-w-3xl">
        <p className="text-sm text-port-error">{error.message || 'Failed to load credentials'}</p>
        <button
          type="button"
          onClick={load}
          className="inline-flex items-center justify-center min-h-[44px] px-3 text-sm bg-port-border hover:bg-port-border/70 text-white rounded transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  if (payload == null) return <BrailleSpinner text="Loading credentials" />;

  const credentials = payload.credentials || [];

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h2 className="text-lg font-semibold text-white">Credentials</h2>
        <p className="text-sm text-gray-400 mt-1">
          {payload.headline || 'Most of PortOS works with no key at all.'}
          {' '}
          This page shows presence and where a value resolved from — never the value itself. Enter or rotate a secret on its existing settings tab.
        </p>
      </div>

      <div className="space-y-3">
        {credentials.map((credential) => {
          const configured = credential.configured === true;
          const verificationUnavailable = credential.verification === 'unavailable';
          return (
            <div
              key={credential.id}
              className="bg-port-card border border-port-border rounded-lg p-4 space-y-2"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-white">{credential.label}</h3>
                  <p className="text-sm text-gray-400 mt-1">{credential.unlocks}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`inline-flex items-center min-h-[28px] px-2 rounded text-xs ${
                    verificationUnavailable
                      ? 'bg-amber-500/15 text-amber-300'
                      : configured
                        ? 'bg-emerald-500/15 text-emerald-300'
                        : 'bg-port-border/60 text-gray-400'
                  }`}>
                    {verificationUnavailable ? 'Could not verify' : configured ? 'Configured' : 'Not configured'}
                  </span>
                  <span className="inline-flex items-center min-h-[28px] px-2 rounded text-xs bg-port-bg text-gray-400">
                    {verificationUnavailable && credential.source === 'none'
                      ? 'Status unknown'
                      : SOURCE_LABEL[credential.source] || SOURCE_LABEL.none}
                  </span>
                  {credential.tier && credential.tier !== 'none' && (
                    <span className="inline-flex items-center min-h-[28px] px-2 rounded text-xs bg-port-bg text-gray-500">
                      {TIER_LABEL[credential.tier] || credential.tier}
                    </span>
                  )}
                </div>
              </div>

              {credential.unavailableFeatures?.length > 0 && (
                <p className="text-xs text-amber-300/90">
                  Currently unavailable:
                  {' '}
                  {credential.unavailableFeatures.map((feature) => feature.label).join(', ')}
                </p>
              )}

              <div className="flex flex-wrap gap-2 pt-1">
                {credential.configurePath && (
                  <Link
                    to={credential.configurePath}
                    className="inline-flex items-center justify-center min-h-[44px] px-3 text-sm bg-port-border hover:bg-port-border/70 text-white rounded transition-colors"
                  >
                    Open {credential.label} settings
                  </Link>
                )}
                {credential.getUrl && (
                  <a
                    href={credential.getUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center justify-center gap-1 min-h-[44px] px-3 text-sm text-port-accent hover:underline"
                  >
                    Get a key
                    <ExternalLink size={14} />
                  </a>
                )}
              </div>
            </div>
          );
        })}
        {credentials.length === 0 && (
          <div className="bg-port-card border border-port-border rounded-lg p-4 text-sm text-gray-400">
            No credentials are registered for this version of PortOS.
          </div>
        )}
      </div>
    </div>
  );
}

export default CredentialsTab;
