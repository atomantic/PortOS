import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { ExternalLink, Network, Server, WandSparkles } from 'lucide-react';
import Drawer from '../Drawer';
import useDrawerTab from '../../hooks/useDrawerTab';
import { FormField } from '../ui/FormField';
import Banner from '../ui/Banner';
import { isLocalEndpoint, isPrivateNetworkEndpoint } from '../../utils/providers';

const FLEET_TABS = [
  { id: 'architecture', label: 'Architecture' },
  { id: 'host', label: 'GPU host' },
  { id: 'client', label: 'Connect client' },
  { id: 'verify', label: 'Verify' },
];
const FLEET_TAB_IDS = FLEET_TABS.map(({ id }) => id);
const DEFAULT_MODEL = 'qwen3.8-27b';
const DEFAULT_PORT = 18020;

const endpointForPeer = (peer) => {
  const rawHost = String(peer?.host || peer?.address || '').trim();
  if (!rawHost) return '';
  const candidate = /^https?:\/\//i.test(rawHost) ? rawHost : `http://${rawHost}`;
  const parsedHost = URL.canParse(candidate) ? new URL(candidate).hostname : rawHost;
  const host = parsedHost.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return `http://${host}:${DEFAULT_PORT}/v1`;
};

const normalizeEndpoint = (value) => {
  const trimmed = String(value || '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return /\/v\d+$/i.test(withScheme) ? withScheme : `${withScheme}/v1`;
};

/**
 * Build the provider record created by the fleet walkthrough.
 *
 * The endpoint intentionally appears twice on an OpenCode record: the provider
 * field drives PortOS model refresh/readiness, while OPENCODE_CONFIG_CONTENT is
 * what the spawned harness actually uses. Updating only the former paints a
 * correct-looking remote card whose agent still calls localhost.
 */
export const buildFleetProvider = ({ name, endpoint, apiKey, model, harness }) => {
  const common = {
    name: name.trim(),
    endpoint,
    apiKey: apiKey.trim(),
    models: [model.trim()],
    defaultModel: model.trim(),
    vllmBacked: true,
    temperature: 0.7,
    topP: 0.8,
    thinking: false,
    timeout: 600000,
    enabled: true,
  };
  if (harness === 'api') return { ...common, type: 'api' };
  return {
    ...common,
    type: 'tui',
    command: 'opencode',
    args: [],
    envVars: {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        permission: 'allow',
        provider: {
          vllm: {
            npm: '@ai-sdk/openai-compatible',
            name: 'Fleet vLLM Qwen3.8-27B',
            options: { baseURL: endpoint },
          },
        },
      }),
    },
    secretEnvVars: [],
    tuiPromptDelayMs: 2500,
    tuiIdleTimeoutMs: 180000,
  };
};

export default function FleetProviderSetup({ peers = [], onClose, onCreate }) {
  const [activeTab, setActiveTab] = useDrawerTab('fleetStep', 'architecture', FLEET_TAB_IDS);
  const [selectedPeerId, setSelectedPeerId] = useState('');
  const [endpointInput, setEndpointInput] = useState('');
  const [name, setName] = useState('Fleet GPU · OpenCode TUI');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [harness, setHarness] = useState('tui');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const availablePeers = useMemo(
    () => peers.filter((peer) => peer?.enabled !== false && (peer?.host || peer?.address)),
    [peers],
  );
  const endpoint = normalizeEndpoint(endpointInput);

  const selectPeer = (peerId) => {
    setSelectedPeerId(peerId);
    const peer = availablePeers.find(({ id }) => id === peerId);
    setEndpointInput(peer ? endpointForPeer(peer) : '');
  };

  const selectHarness = (next) => {
    setHarness(next);
    setName(next === 'tui' ? 'Fleet GPU · OpenCode TUI' : 'Fleet GPU · API');
  };

  const submit = (event) => {
    event.preventDefault();
    setError('');
    if (!name.trim()) return setError('Provider name is required.');
    if (!URL.canParse(endpoint)) return setError('Enter a full HTTP endpoint for the GPU host.');
    if (isLocalEndpoint(endpoint) || !isPrivateNetworkEndpoint(endpoint)) {
      return setError('Use a private LAN, MagicDNS, or Tailscale endpoint on another machine.');
    }
    if (!apiKey.trim()) return setError('The networked vLLM runtime must have an API key.');
    if (!model.trim()) return setError('Model id is required.');

    setSaving(true);
    return onCreate(buildFleetProvider({ name, endpoint, apiKey, model, harness }))
      .then(onClose)
      .catch((err) => setError(err?.message || 'Could not create the fleet provider.'))
      .finally(() => setSaving(false));
  };

  return (
    <Drawer
      open
      onClose={onClose}
      title="Fleet LLM setup"
      subtitle="Use one dedicated GPU host from every PortOS instance"
      size="lg"
      tabs={FLEET_TABS}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      closeOnEsc={false}
      closeOnBackdrop={false}
    >
      {activeTab === 'architecture' && (
        <div className="space-y-4 text-sm text-gray-300">
          <Banner tone="success" icon={WandSparkles}>
            <p className="font-medium">Recommended for one RTX 3090: vLLM + Qwen3.8-27B + DFlash2 on the host, OpenCode TUI on coding clients.</p>
            <p className="mt-1 text-port-success/80">Use a direct API provider instead when PortOS only needs text synthesis. Both connect straight to the same authenticated OpenAI-compatible endpoint over Tailscale.</p>
          </Banner>

          <div className="grid gap-3 sm:grid-cols-2">
            <RuntimeChoice
              title="vLLM DFlash2"
              badge="3090 default"
              body="Measured on the RTX 3090, supports prefix caching, tool calls, concurrent request slots, and an authenticated network server. Best fit for an always-on fleet host."
            />
            <RuntimeChoice
              title="EXL3 + MTP / DFlash2"
              badge="Context alternative"
              body="The MiaAI-Lab kit fits the native 262K window with MTP and 3.5-bpw weights, but its published numbers are from GB10 and its server queues at batch one. Keep it as the long-context experiment until it is measured on the 3090."
            />
            <RuntimeChoice
              title="LM Studio"
              badge="Easy fallback"
              body="The simplest desktop-managed network API and already supported by PortOS. It does not run this EXL3 deployment kit and is less reproducible as a dedicated appliance."
            />
            <RuntimeChoice
              title="MTPLX"
              badge="Apple Silicon"
              body="A native-MTP option for Apple Silicon, not the CUDA runtime for a 3090. Use it for a Mac fleet host, not this hardware."
            />
          </div>

          <p className="text-xs text-gray-500">
            The runtime is reached directly rather than proxied through PortOS. That avoids an extra hop and lets OpenCode use the standard OpenAI-compatible tool stream.
          </p>
        </div>
      )}

      {activeTab === 'host' && (
        <div className="space-y-4 text-sm text-gray-300">
          <Banner tone="info" icon={Server}>
            Do this on the dedicated RTX 3090 PortOS instance. No model download or provider call happens from this walkthrough.
          </Banner>
          <ol className="list-decimal pl-5 space-y-3">
            <li>Open <strong>Load Samples</strong> on AI Providers and add <strong>OpenCode vLLM TUI (Qwen3.8-27B)</strong>.</li>
            <li>Use that card’s setup checklist to prepare the vLLM stack. Set <code>SPEC=dflash2</code>, <code>PREFIX_CACHE=1</code>, and a strong <code>VLLM_API_KEY</code>.</li>
            <li>Keep the runtime bound on port <code>18020</code>. The stack listens on the network; use Tailscale ACLs and the API key to limit clients.</li>
            <li>Because this is a dedicated host, configure the container to restart unless stopped. Do not do that on a mixed media workstation: the model occupies nearly the whole GPU.</li>
            <li>Confirm <code>/v1/models</code> answers through the host’s MagicDNS name or Tailscale IP before configuring clients.</li>
          </ol>
          <div className="flex flex-wrap gap-3">
            <a
              href="https://github.com/atomantic/PortOS/blob/main/docs/features/fleet-llm-host.md"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-port-accent hover:underline"
            >
              Fleet host guide <ExternalLink size={13} />
            </a>
            <a
              href="https://github.com/syv-ai/qwen38-27b-rtx3090"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-port-accent hover:underline"
            >
              Runtime source <ExternalLink size={13} />
            </a>
          </div>
        </div>
      )}

      {activeTab === 'client' && (
        <form onSubmit={submit} className="space-y-4">
          <Banner tone="info" icon={Network}>
            Create this provider on each client PortOS instance. The saved endpoint and the spawned OpenCode harness will point at the same fleet host.
          </Banner>

          {availablePeers.length > 0 && (
            <FormField label="Known PortOS peer">
              <select
                value={selectedPeerId}
                onChange={(event) => selectPeer(event.target.value)}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
              >
                <option value="">Enter an endpoint manually</option>
                {availablePeers.map((peer) => (
                  <option key={peer.id} value={peer.id}>
                    {peer.name || peer.host || peer.address}{peer.status ? ` · ${peer.status}` : ''}
                  </option>
                ))}
              </select>
            </FormField>
          )}

          <FormField label="GPU host endpoint" hint="Use the runtime endpoint, not the PortOS :5555 address.">
            <input
              type="text"
              value={endpointInput}
              onChange={(event) => {
                setSelectedPeerId('');
                setEndpointInput(event.target.value);
              }}
              placeholder="http://gpu-host.example.ts.net:18020/v1"
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
            />
          </FormField>

          <FormField label="Harness">
            <select
              value={harness}
              onChange={(event) => selectHarness(event.target.value)}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
            >
              <option value="tui">OpenCode TUI — coding agents (recommended)</option>
              <option value="api">Direct API — text and thinking workflows</option>
            </select>
          </FormField>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Provider name">
              <input
                type="text"
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
              />
            </FormField>
            <FormField label="Served model id">
              <input
                type="text"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
              />
            </FormField>
          </div>

          <FormField label="vLLM API key" hint="Use the VLLM_API_KEY configured on the GPU host.">
            <input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              autoComplete="off"
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
            />
          </FormField>

          {error && <Banner tone="error">{error}</Banner>}

          <div className="flex items-center justify-between gap-3 pt-2">
            <Link to="/instances" className="text-sm text-port-accent hover:underline">Manage peers</Link>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 rounded-lg bg-port-accent hover:bg-port-accent/80 text-white disabled:opacity-50"
            >
              {saving ? 'Creating…' : 'Create fleet provider'}
            </button>
          </div>
        </form>
      )}

      {activeTab === 'verify' && (
        <div className="space-y-4 text-sm text-gray-300">
          <ol className="list-decimal pl-5 space-y-3">
            <li>Open the new card and click <strong>Refresh Models</strong>. Confirm the served id appears.</li>
            <li>Click <strong>Test</strong>. A fleet badge should name the remote host and no local-runtime installer should appear.</li>
            <li>For the TUI harness, click <strong>Launch in Shell</strong> and ask it to inspect a small workspace before assigning unattended tasks.</li>
            <li>Set it as the default only after the tool-call test succeeds. Keep a cloud or local fallback for host maintenance and reboots.</li>
          </ol>
          <Banner tone="warning">
            A Tailscale connection protects transport inside the tailnet; the API key still prevents another tailnet process from using the model accidentally. Never copy the key into a shared issue, log, or provider name.
          </Banner>
        </div>
      )}
    </Drawer>
  );
}

function RuntimeChoice({ title, badge, body }) {
  return (
    <section className="rounded-lg border border-port-border bg-port-bg/50 p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium text-white">{title}</h3>
        <span className="rounded bg-port-border px-2 py-0.5 text-[11px] uppercase tracking-wide text-gray-300">{badge}</span>
      </div>
      <p className="text-xs leading-relaxed text-gray-400">{body}</p>
    </section>
  );
}
