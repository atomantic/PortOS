import { useCallback, useEffect, useState } from 'react';
import BrailleSpinner from '../BrailleSpinner';
import toast from '../ui/Toast';
import { getDockerContainmentStatus, pullDockerContainmentImage } from '../../services/api';

const ENGINE_STATE_LABELS = {
  ready: 'Ready',
  'docker-missing': 'Docker is not installed',
  'docker-stopped': 'Docker is not running',
  'docker-unsupported': 'Docker cannot run Linux containers here',
  'docker-remote-refused': 'The Docker endpoint is not local',
};

// The Docker containment row's status in Settings > Features (#12844). Rendered
// only while the feature is on, so a fresh install never makes a Docker call;
// it reads the engine verdict here rather than on the shared feature list
// because the sidebar and ⌘K read that list on every page load.
export function DockerContainmentCard() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [checking, setChecking] = useState(false);
  const [pulling, setPulling] = useState(null);

  const load = useCallback(async () => {
    setChecking(true);
    // Silent: shown inline on the card, not as a toast on every Settings visit.
    const result = await getDockerContainmentStatus({ silent: true }).catch((err) => err);
    if (result instanceof Error) setError(result);
    else {
      setError(null);
      setStatus(result);
    }
    setChecking(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handlePull = async (major) => {
    setPulling(major);
    const result = await pullDockerContainmentImage(major, { silent: true }).catch((err) => err);
    setPulling(null);
    if (result instanceof Error) {
      toast.error(result.message || `Could not pull the Node ${major} image`);
      return;
    }
    toast.success(`Pulled the Node ${major} image`);
    setStatus((current) => current && {
      ...current,
      images: current.images.map((image) => (image.major === major ? { ...image, present: true } : image)),
    });
  };

  if (error) {
    return (
      <div className="mt-3 text-xs text-port-error">
        <p>{error.message || 'Could not read the Docker containment status'}</p>
        <button
          type="button"
          onClick={load}
          className="inline-flex items-center justify-center min-h-[44px] px-3 mt-2 text-sm bg-port-border hover:bg-port-border/70 text-white rounded transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!status) return <div className="mt-3"><BrailleSpinner text="Checking for a local Docker engine" /></div>;

  return (
    <div className="mt-3 space-y-2 text-xs text-gray-400">
      <p className={status.ready ? 'text-port-success' : 'text-port-warning'}>
        {ENGINE_STATE_LABELS[status.state] ?? status.state}
      </p>
      <p>{status.message}</p>
      {status.engine && (
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
          <div className="min-w-0">
            <dt className="text-gray-500">Engine</dt>
            <dd className="break-all text-gray-300">{status.engine.label}{status.engine.serverVersion ? ` ${status.engine.serverVersion}` : ''}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-gray-500">Context</dt>
            <dd className="break-all text-gray-300">{status.engine.context || 'DOCKER_HOST'}</dd>
          </div>
        </dl>
      )}
      {status.ready && status.images.length > 0 && (
        <ul className="space-y-1" aria-label="Pinned Node images">
          {status.images.map((image) => (
            <li key={image.major} className="flex flex-wrap items-center gap-2">
              <span className="text-gray-300">Node {image.major}</span>
              {image.present
                ? <span className="text-port-success">pulled</span>
                : (
                  <button
                    type="button"
                    onClick={() => handlePull(image.major)}
                    disabled={pulling !== null}
                    className="inline-flex items-center justify-center min-h-[44px] px-3 text-sm bg-port-accent hover:bg-port-accent/80 disabled:opacity-50 text-white rounded transition-colors"
                  >
                    {pulling === image.major ? 'Pulling…' : 'Pull image'}
                  </button>
                )}
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        onClick={load}
        disabled={checking}
        className="inline-flex items-center justify-center min-h-[44px] px-3 text-sm bg-port-border hover:bg-port-border/70 disabled:opacity-50 text-white rounded transition-colors"
      >
        {checking ? 'Rechecking…' : 'Recheck Docker'}
      </button>
    </div>
  );
}

export default DockerContainmentCard;
