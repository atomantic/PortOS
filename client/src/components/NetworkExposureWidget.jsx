import { useState, useEffect, memo, useMemo } from 'react';
import {
  Shield,
  ShieldAlert,
  ShieldCheck,
  Globe,
  Lock,
  Unlock,
  Mic,
  MicOff,
  ExternalLink,
  AlertTriangle,
  CheckCircle
} from 'lucide-react';
import * as api from '../services/api';
import { isLoopbackOrigin, describeMicAvailability } from '../lib/loopbackHost.js';

function CertModeBadge({ mode, host }) {
  if (mode === 'tailscale') {
    return (
      <div className="flex items-center gap-2 text-sm">
        <ShieldCheck size={14} className="text-port-success" />
        <span className="text-port-success">Trusted via Tailscale</span>
        {host && (
          <span className="text-gray-500 truncate" title={host}>· {host}</span>
        )}
      </div>
    );
  }
  if (mode === 'self-signed') {
    return (
      <div className="flex items-center gap-2 text-sm">
        <Shield size={14} className="text-port-warning" />
        <span className="text-port-warning">Self-signed cert</span>
      </div>
    );
  }
  if (mode === 'unknown') {
    return (
      <div className="flex items-center gap-2 text-sm">
        <Shield size={14} className="text-gray-400" />
        <span className="text-gray-400">HTTPS · cert metadata missing</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 text-sm">
      <ShieldAlert size={14} className="text-port-warning" />
      <span className="text-port-warning">No TLS — plain HTTP</span>
    </div>
  );
}

const NetworkExposureWidget = memo(function NetworkExposureWidget() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api.getNetworkExposure({ silent: true })
      .then((data) => {
        if (!cancelled) setStatus(data);
      })
      .catch(() => {
        if (!cancelled) setStatus(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const mic = useMemo(() => describeMicAvailability(), []);

  if (loading || !status) return null;

  const { scheme, httpsEnabled, bind, loopbackMirror, cert, docsUrl } = status;
  const SchemeIcon = httpsEnabled ? Lock : Unlock;
  const schemeColor = httpsEnabled ? 'text-port-success' : 'text-port-warning';

  // "Surface area" warning — server bound on all interfaces with no TLS means
  // any device on the LAN/Tailnet can speak plain HTTP to it. PortOS expects
  // to live behind Tailscale, so we flag this rather than silently allow it.
  const exposedOverInsecureWan =
    !httpsEnabled && bind?.audience === 'all-interfaces';

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-4 sm:p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-lg ${httpsEnabled ? 'bg-port-success/10' : 'bg-port-warning/10'}`}>
            <Globe className={`w-5 h-5 ${schemeColor}`} />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-white">Network Exposure</h3>
            <div className="flex items-center gap-2 text-sm">
              <SchemeIcon size={14} className={schemeColor} />
              <span className={schemeColor}>{scheme.toUpperCase()}</span>
              <span className="text-gray-500">·</span>
              <span className="text-gray-400 font-mono text-xs">
                {bind.host}:{bind.port}
              </span>
            </div>
          </div>
        </div>
      </div>

      {exposedOverInsecureWan && (
        <div className="mb-4 flex items-start gap-2 px-3 py-2 rounded-lg bg-port-warning/10 text-port-warning text-sm">
          <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
          <span>
            Bound on all interfaces over plain HTTP — anyone on this LAN/Tailnet
            can reach PortOS unencrypted. Run <code className="font-mono">npm run setup:cert</code> to enable HTTPS.
          </span>
        </div>
      )}

      <dl className="space-y-3 text-sm">
        <div className="flex items-start justify-between gap-3">
          <dt className="text-gray-500 flex items-center gap-2">
            <Shield size={14} />
            Cert mode
          </dt>
          <dd className="text-right min-w-0">
            <CertModeBadge mode={cert.mode} host={cert.tailscaleHost} />
          </dd>
        </div>

        <div className="flex items-start justify-between gap-3">
          <dt className="text-gray-500 flex items-center gap-2">
            <Globe size={14} />
            Bind audience
          </dt>
          <dd className="text-right text-gray-300">
            {bind.audience === 'loopback-only' && 'Loopback only'}
            {bind.audience === 'all-interfaces' && 'All interfaces'}
            {bind.audience === 'specific-interface' && (
              <span className="font-mono text-xs">{bind.host}</span>
            )}
          </dd>
        </div>

        {loopbackMirror.enabled && (
          <div className="flex items-start justify-between gap-3">
            <dt className="text-gray-500 flex items-center gap-2">
              <Unlock size={14} />
              Loopback HTTP mirror
            </dt>
            <dd className="text-right text-gray-300">
              {/* Mirror is bound to 127.0.0.1 server-side, so it's only
                  reachable when the browser is on the same host. Anywhere
                  else (Tailscale IP, LAN), an `http://localhost:5553` link
                  would resolve to the viewer's own machine and 404 — show
                  informational text instead of a broken link. */}
              {isLoopbackOrigin() ? (
                // Explicit 127.0.0.1, not `localhost`, because the mirror
                // listener binds to 127.0.0.1 specifically — an IPv6-
                // preferring resolver might map `localhost` to `::1` first
                // and the link would fail with ECONNREFUSED.
                <a
                  href={`http://127.0.0.1:${loopbackMirror.port}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-xs text-port-accent hover:underline"
                >
                  :{loopbackMirror.port}
                </a>
              ) : (
                <span className="font-mono text-xs text-gray-500" title="Reachable only from the PortOS host machine">
                  :{loopbackMirror.port} (host-only)
                </span>
              )}
            </dd>
          </div>
        )}

        <div className="flex items-start justify-between gap-3">
          <dt className="text-gray-500 flex items-center gap-2">
            {mic.available ? <Mic size={14} /> : <MicOff size={14} />}
            Voice / mic
          </dt>
          <dd className="text-right">
            {mic.available ? (
              <div className="flex items-center gap-1 text-port-success">
                <CheckCircle size={14} />
                <span>Available</span>
                <span className="text-gray-500 text-xs">
                  ({mic.reason === 'https' ? 'HTTPS' : 'loopback'})
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-1 text-port-warning">
                <AlertTriangle size={14} />
                <span>Blocked — HTTP on non-loopback origin</span>
              </div>
            )}
          </dd>
        </div>
      </dl>

      <div className="mt-4 pt-3 border-t border-port-border">
        <a
          href={docsUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-sm text-port-accent hover:text-port-accent/80"
        >
          <span>Port + scheme guide</span>
          <ExternalLink size={12} />
        </a>
      </div>
    </div>
  );
});

export default NetworkExposureWidget;
