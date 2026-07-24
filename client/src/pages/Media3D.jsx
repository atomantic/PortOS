import { useCallback, useEffect, useState } from 'react';
import { Boxes, CheckCircle2, Download, AlertTriangle, Loader2, ExternalLink } from 'lucide-react';
import { getImageTo3dTargets } from '../services/api';
import RuntimeInstallModal from '../components/install/RuntimeInstallModal';

// Human-readable reasons a target can't run on this host, keyed by the stable
// reason code the registry returns (server/services/imageTo3d/targets.js).
const REASON_LABEL = {
  'requires-apple-silicon': 'Requires an Apple Silicon Mac',
  'insufficient-memory': 'Needs 24 GB+ of unified memory',
  'requires-cuda': 'Requires an NVIDIA CUDA GPU',
  'unknown-target': 'Unavailable',
};

const LANE_LABEL = {
  'local-mps': 'Runs on-device (Apple Silicon)',
  'local-cuda': 'Runs on-device (CUDA)',
  'hosted-api': 'Hosted API',
};

function StatusBadge({ target }) {
  if (!target.available) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-port-warning">
        <AlertTriangle className="w-3.5 h-3.5" />
        {REASON_LABEL[target.unavailableReason] || 'Unsupported on this host'}
      </span>
    );
  }
  if (target.installed) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-port-success">
        <CheckCircle2 className="w-3.5 h-3.5" /> Ready
      </span>
    );
  }
  return null;
}

function TargetCard({ target, onInstall }) {
  // Install only applies to targets with a local install concept (installed is a
  // boolean); hosted targets report installed:null and are Ready when available.
  const canInstall = target.available && target.installed === false;

  return (
    <div className="rounded-lg border border-port-border bg-port-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-white">{target.label}</h2>
            {target.executionLane && (
              <span className="rounded bg-port-bg px-1.5 py-0.5 text-[11px] text-gray-400">
                {LANE_LABEL[target.executionLane] || target.executionLane}
              </span>
            )}
          </div>
          {target.description && (
            <p className="mt-1 text-xs text-gray-400">{target.description}</p>
          )}
          {(target.upstream || target.port) && (
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-gray-500">
              {target.upstream && (
                <a href={target.upstream} target="_blank" rel="noreferrer"
                  className="inline-flex items-center gap-1 hover:text-port-accent">
                  <ExternalLink className="w-3 h-3" /> Upstream
                </a>
              )}
              {target.port && (
                <a href={target.port} target="_blank" rel="noreferrer"
                  className="inline-flex items-center gap-1 hover:text-port-accent">
                  <ExternalLink className="w-3 h-3" /> Apple Silicon port
                </a>
              )}
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <StatusBadge target={target} />
          {canInstall && (
            <button
              onClick={() => onInstall(target)}
              className="inline-flex items-center gap-1.5 rounded-md bg-port-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-600"
            >
              <Download className="w-3.5 h-3.5" /> Install
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Media3D() {
  const [targets, setTargets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // The target whose install modal is open (only local-install targets); null = closed.
  const [installTarget, setInstallTarget] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    getImageTo3dTargets()
      .then((data) => { setTargets(data?.targets || []); setError(null); })
      .catch((err) => setError(err?.message || 'Failed to load 3D targets'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="mx-auto max-w-4xl">
      <header className="mb-5">
        <div className="flex items-center gap-2">
          <Boxes className="h-5 w-5 text-port-accent" />
          <h1 className="text-lg font-semibold text-white">3D</h1>
        </div>
        <p className="mt-1 text-sm text-gray-400">
          Turn a rendered image into a 3D mesh. Install and manage the image-to-3D models here;
          generation from an image lands next.
        </p>
      </header>

      {loading && (
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading models…
        </div>
      )}

      {error && !loading && (
        <div className="flex items-center justify-between rounded-lg border border-port-error/40 bg-port-error/10 p-4 text-sm text-port-error">
          <span>{error}</span>
          <button onClick={load} className="rounded-md border border-port-error/50 px-3 py-1 text-xs hover:bg-port-error/20">
            Retry
          </button>
        </div>
      )}

      {!loading && !error && (
        <div className="space-y-3">
          {targets.length === 0 && (
            <p className="text-sm text-gray-500">No image-to-3D models are registered.</p>
          )}
          {targets.map((target) => (
            <TargetCard key={target.id} target={target} onInstall={setInstallTarget} />
          ))}
        </div>
      )}

      {/* TRELLIS.2 (and any future local-install target) streams its clone +
          setup.sh install through the shared runtime-install modal. */}
      <RuntimeInstallModal
        open={!!installTarget}
        runtime={installTarget?.id}
        label={installTarget?.label}
        installUrlBase="/api/image-to-3d/trellis2/install"
        description="Cloning the TRELLIS.2 (Apple Silicon) port and installing its Python environment. The model weights are a large download on first run (~15 GB)."
        onClose={() => setInstallTarget(null)}
        onComplete={() => { setInstallTarget(null); load(); }}
      />
    </div>
  );
}
