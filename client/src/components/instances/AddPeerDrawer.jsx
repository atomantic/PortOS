import { useState, useEffect } from 'react';
import { Plus, Lock } from 'lucide-react';
import Drawer from '../Drawer';
import toast from '../ui/Toast';
import { addPeer, addTailcatPeer, startTailcatServe } from '../../services/apiSystem.js';
import { DEFAULT_PEER_PORT, DEFAULT_TAILCAT_LOCAL_PORT, DEFAULT_TAILCAT_REMOTE_PORT } from '../../lib/ports.js';
import { useTailcatServe } from './TailcatServeProvider';
import TailcatAddress from './TailcatAddress';

// Exported for focused tests (the port input's placeholder must advertise the
// same default the form actually submits — see Instances.test.jsx).
export function AddPeerForm({ onAdd, addressRef, drawer }) {
  const [mode, setMode] = useState('classic'); // 'classic' | 'tailcat'
  // Dial polarity for Tailcat: we dial their serve, or they dial ours.
  const [dialDirection, setDialDirection] = useState('dial-them'); // 'dial-them' | 'they-dial-us'
  const [address, setAddress] = useState('');
  const [tcAddress, setTcAddress] = useState('');
  const [tailcatRemotePort, setTailcatRemotePort] = useState(String(DEFAULT_TAILCAT_REMOTE_PORT));
  const [tailcatHttps, setTailcatHttps] = useState(false);
  const [port, setPort] = useState(String(DEFAULT_PEER_PORT));
  const [name, setName] = useState('');
  const [showAuth, setShowAuth] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [adding, setAdding] = useState(false);
  const { status: serveStatus, busy: serveBusy, run: runServe } = useTailcatServe();

  // This component stays mounted above its Drawer, retaining drafts on close.
  useEffect(() => {
    if (drawer?.open) addressRef?.current?.focus();
  }, [drawer?.open, addressRef]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (mode === 'tailcat') {
      if (dialDirection === 'they-dial-us') return; // serve path uses its own buttons
      if (!tcAddress.trim()) return;
      setAdding(true);
      const data = { tcAddress: tcAddress.trim(), remotePort: Number(tailcatRemotePort) };
      if (tailcatHttps) data.protocol = 'https';
      if (name.trim()) data.name = name.trim();
      if (password) data.auth = { username: username.trim(), password };
      const result = await addTailcatPeer(data).catch(() => null);
      setAdding(false);
      if (!result) return;
      setTcAddress('');
      setName('');
      setUsername('');
      setPassword('');
      setShowAuth(false);
      onAdd();
      toast.success(`Peer added via tailcat (local :${result.port || DEFAULT_TAILCAT_LOCAL_PORT})`);
      return;
    }
    if (!address.trim()) return;
    setAdding(true);
    const data = { address: address.trim(), port: parseInt(port, 10) || DEFAULT_PEER_PORT };
    if (name.trim()) data.name = name.trim();
    // Only attach credentials when a password was entered — username alone
    // (or neither) is treated as "no auth" by the server's sanitizer.
    if (password) data.auth = { username: username.trim(), password };
    const result = await addPeer(data).catch(() => null);
    setAdding(false);
    if (!result) return;
    setAddress('');
    setPort(String(DEFAULT_PEER_PORT));
    setName('');
    setUsername('');
    setPassword('');
    setShowAuth(false);
    onAdd();
    toast.success('Peer added');
  };

  const ensureOurServe = async () => {
    const result = await runServe(() => startTailcatServe({}), 'Tailcat serve is running — copy the address for the other node');
    if (result) onAdd?.();
  };

  const canSubmit = mode === 'tailcat'
    ? (dialDirection === 'dial-them' && !!tcAddress.trim())
    : !!address.trim();

  const form = (
    <form onSubmit={handleSubmit} className="bg-port-card border border-port-border rounded-xl p-5">
      <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-3 flex items-center gap-2">
        <Plus size={14} /> Add Peer
      </h3>
      <div className="flex flex-wrap gap-2 mb-3">
        <button
          type="button"
          aria-pressed={mode === 'classic'}
          disabled={adding || serveBusy}
          onClick={() => setMode('classic')}
          className={`text-xs px-2.5 py-1 min-h-11 rounded border transition-colors ${mode === 'classic' ? 'border-port-accent text-white bg-port-accent/20' : 'border-port-border text-gray-500 hover:text-gray-300'}`}
        >
          Host / port
        </button>
        <button
          type="button"
          aria-pressed={mode === 'tailcat'}
          disabled={adding || serveBusy}
          onClick={() => setMode('tailcat')}
          className={`text-xs px-2.5 py-1 min-h-11 rounded border transition-colors ${mode === 'tailcat' ? 'border-port-accent text-white bg-port-accent/20' : 'border-port-border text-gray-500 hover:text-gray-300'}`}
        >
          Tailcat
        </button>
      </div>
      {mode === 'tailcat' && (
        <div className="flex flex-wrap gap-2 mb-3" role="group" aria-label="Tailcat dial direction">
          <button
            type="button"
            aria-pressed={dialDirection === 'dial-them'}
            disabled={adding || serveBusy}
            onClick={() => setDialDirection('dial-them')}
            className={`text-xs px-2.5 py-1 min-h-11 rounded border transition-colors ${dialDirection === 'dial-them' ? 'border-port-accent text-white bg-port-accent/20' : 'border-port-border text-gray-500 hover:text-gray-300'}`}
          >
            Dial them
          </button>
          <button
            type="button"
            aria-pressed={dialDirection === 'they-dial-us'}
            disabled={adding || serveBusy}
            onClick={() => setDialDirection('they-dial-us')}
            className={`text-xs px-2.5 py-1 min-h-11 rounded border transition-colors ${dialDirection === 'they-dial-us' ? 'border-port-accent text-white bg-port-accent/20' : 'border-port-border text-gray-500 hover:text-gray-300'}`}
          >
            They dial us
          </button>
        </div>
      )}
      {mode === 'tailcat' && dialDirection === 'dial-them' ? (
        <div className="flex flex-wrap gap-2">
          <input
            ref={addressRef}
            aria-label="Tailcat address"
            value={tcAddress}
            onChange={e => setTcAddress(e.target.value)}
            placeholder="tcEXAMPLE…"
            required
            className="bg-port-bg border border-port-border rounded px-3 py-2 min-h-11 text-sm text-white placeholder-gray-600 focus:outline-hidden focus:border-port-accent flex-1 min-w-[200px] font-mono"
          />
          <input type="number" aria-label="Remote Tailcat port" min="1" max="65535" required
            value={tailcatRemotePort} onChange={(event) => setTailcatRemotePort(event.target.value)}
            title="Use the port shown beside the remote serve address; older manually served peers may use 5555"
            className="w-24 bg-port-bg border border-port-border rounded px-3 py-2 min-h-11 text-sm" />
          <input
            aria-label="Peer name"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Name (optional)"
            className="bg-port-bg border border-port-border rounded px-3 py-2 min-h-11 text-sm text-white placeholder-gray-600 focus:outline-hidden focus:border-port-accent flex-1 min-w-[120px]"
          />
          <button
            type="submit"
            disabled={adding || !canSubmit}
            className="bg-port-accent hover:bg-port-accent/80 disabled:opacity-50 text-white px-4 py-2 min-h-11 rounded text-sm font-medium transition-colors"
          >
            {adding ? 'Connecting...' : 'Add via tailcat'}
          </button>
        </div>
      ) : mode === 'tailcat' && dialDirection === 'they-dial-us' ? (
        <div className="space-y-3">
          <p className="text-[11px] text-gray-500 leading-snug">
            Start serve on this node, copy our <span className="font-mono">tc…</span> address,
            and paste it into the <em>other</em> PortOS as <strong>Dial them</strong>
            using remote port <strong>{serveStatus?.localPort || DEFAULT_TAILCAT_REMOTE_PORT}</strong>.
            Use this when the other machine is a better outbound initiator
            (client firewall / Little Snitch often blocks home dials).
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={serveBusy || serveStatus?.live}
              onClick={ensureOurServe}
              className="bg-port-accent hover:bg-port-accent/80 disabled:opacity-50 text-white px-4 py-2 min-h-11 rounded text-sm font-medium transition-colors"
            >
              {serveBusy ? 'Starting...' : (serveStatus?.live ? 'Serve running' : 'Start serve')}
            </button>
          </div>
          <TailcatAddress address={serveStatus?.tcAddress} preview={serveStatus?.tcAddressRedacted}
            disabled={serveBusy} label="Copy our address" />
        </div>
      ) : (
      <div className="flex flex-wrap gap-2">
        <input
          ref={addressRef}
          aria-label="Peer address"
          value={address}
          onChange={e => setAddress(e.target.value)}
          placeholder="100.64.x.x"
          pattern="^((25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(25[0-5]|2[0-4]\d|[01]?\d\d?)$"
          required
          className="bg-port-bg border border-port-border rounded px-3 py-2 min-h-11 text-sm text-white placeholder-gray-600 focus:outline-hidden focus:border-port-accent flex-1 min-w-[140px]"
        />
        <input
          aria-label="Peer port"
          value={port}
          onChange={e => setPort(e.target.value)}
          placeholder={String(DEFAULT_PEER_PORT)}
          type="number"
          min="1"
          max="65535"
          className="bg-port-bg border border-port-border rounded px-3 py-2 min-h-11 text-sm text-white placeholder-gray-600 focus:outline-hidden focus:border-port-accent w-20"
        />
        <input
          aria-label="Peer name"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Name (optional)"
          className="bg-port-bg border border-port-border rounded px-3 py-2 min-h-11 text-sm text-white placeholder-gray-600 focus:outline-hidden focus:border-port-accent flex-1 min-w-[120px]"
        />
        <button
          type="submit"
          disabled={adding || !canSubmit}
          className="bg-port-accent hover:bg-port-accent/80 disabled:opacity-50 text-white px-4 py-2 min-h-11 rounded text-sm font-medium transition-colors"
        >
          {adding ? 'Adding...' : 'Add'}
        </button>
      </div>
      )}
      {mode === 'tailcat' && dialDirection === 'dial-them' && (
        <>
          <label htmlFor="tailcat-https" className="flex items-center gap-2 min-h-11 text-sm text-gray-400 mt-3">
            <input id="tailcat-https" type="checkbox" checked={tailcatHttps}
              onChange={e => setTailcatHttps(e.target.checked)} disabled={adding} />
            Remote PortOS uses HTTPS
          </label>
          <p className="text-[11px] text-gray-500 mt-2 leading-snug">
            Forwards <span className="font-mono text-gray-400">127.0.0.1:{DEFAULT_TAILCAT_LOCAL_PORT}</span>
            {' '}→ remote <span className="font-mono text-gray-400">:{tailcatRemotePort || DEFAULT_TAILCAT_REMOTE_PORT}</span> via tailcat
            (next free port if {DEFAULT_TAILCAT_LOCAL_PORT} is busy). No Tailscale account required.
            Tailcat is installed with Homebrew (or Go) if needed.
          </p>
        </>
      )}
      <div className="mt-2">
        <button
          type="button"
          onClick={() => setShowAuth(v => !v)}
          className="inline-flex items-center gap-1 min-h-11 text-[11px] text-gray-500 hover:text-gray-300 transition-colors"
        >
          <Lock size={11} />
          {showAuth ? 'Hide credentials' : 'Add credentials (peer behind an auth proxy)'}
        </button>
        {showAuth && (
          <div className="flex flex-wrap gap-2 mt-2">
            <input
              aria-label="Peer username"
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="Username (optional)"
              autoComplete="off"
              className="bg-port-bg border border-port-border rounded px-3 py-2 min-h-11 text-sm text-white placeholder-gray-600 focus:outline-hidden focus:border-port-accent flex-1 min-w-[120px]"
            />
            <input
              aria-label="Peer password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Password"
              type="password"
              autoComplete="new-password"
              className="bg-port-bg border border-port-border rounded px-3 py-2 min-h-11 text-sm text-white placeholder-gray-600 focus:outline-hidden focus:border-port-accent flex-1 min-w-[120px]"
            />
          </div>
        )}
      </div>
    </form>
  );
  return drawer
    ? <Drawer {...drawer} title="Add peer" closeLabel="Close add peer">{form}</Drawer>
    : form;
}
