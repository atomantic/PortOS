import { useState } from 'react';
import { Link } from 'react-router';
import { SPLASH_LAUNCH_COMMAND, SPLASH_MODEL, SPLASH_RELEASE_URL } from '../../../../server/lib/splashRuntime.js';

const statusMessage = (status) => {
  if (!status) return 'Status unavailable.';
  if (status.state === 'external') {
    return status.model === SPLASH_MODEL
      ? `Ready: serving ${status.model}.`
      : `Serving ${status.model}. The shipped presets use ${SPLASH_MODEL}; update their model selection or start the server with the name below.`;
  }
  if (status.state === 'not-ready') return 'Splash is listening but not ready. Check the terminal for model download, loading, or recovery.';
  if (status.state === 'unrecognized') return 'A server answered at the preset port, but Splash readiness and model listing could not be verified. Check for a port conflict or authentication.';
  if (status.state === 'stopped') return 'Splash is installed but not answering at the preset port.';
  if (status.state === 'missing') return 'Splash is not on PATH and no ready server was found.';
  return 'This machine does not support the local Splash runtime.';
};

export default function SplashRuntimeCard({ status, onRefresh }) {
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    setRefreshing(true);
    try { await onRefresh(); } finally { setRefreshing(false); }
  };

  return (
    <section className="bg-port-card border border-port-border rounded-xl p-4 sm:p-6 space-y-3">
      <h3 className="text-sm font-medium text-white">Splash · Inkling 2 Mini</h3>
      <p className="text-xs text-gray-400">Optional and started in a terminal. PortOS checks readiness but does not install, start, or stop Splash. This does not change your default backend.</p>
      <p role="status" className="text-sm text-gray-300">{refreshing ? 'Checking Splash…' : statusMessage(status)}</p>
      <button type="button" disabled={refreshing} onClick={refresh} className="min-h-[44px] rounded border border-port-border bg-port-card px-3 text-sm text-white hover:bg-port-border/70 disabled:opacity-50">
        Check Splash status
      </button>
      {status?.supported !== false && <>
        <p className="text-xs text-gray-400">Requires macOS 26.4+ on Apple M3 or later. Install the Splash CLI from the <a className="text-port-accent hover:underline" href={SPLASH_RELEASE_URL} target="_blank" rel="noreferrer">Splash release</a>. The first launch downloads the model weights and its drafter, so allow room for several tens of GB.</p>
        <pre className="text-xs text-gray-300 whitespace-pre-wrap break-all rounded border border-port-border p-3 select-all"><code>{SPLASH_LAUNCH_COMMAND}</code></pre>
        <p className="text-xs text-gray-400">Keep it on loopback. When ready, enable <strong>OpenCode · Splash (local)</strong> or <strong>Claude Code · Splash (local)</strong> in <Link to="/ai" className="text-port-accent hover:underline">AI Providers</Link>. To stop Splash, use Ctrl+C in its terminal.</p>
      </>}
    </section>
  );
}
