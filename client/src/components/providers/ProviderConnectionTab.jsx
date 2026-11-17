import { Link } from 'react-router';
import { AlertTriangle, Link2 } from 'lucide-react';
import Banner from '../ui/Banner';
import { FormField } from '../ui/FormField';
import { GatewayKeyHint } from './ProviderNotices';
import { gatewayForProvider, isClaudeCommandProvider, isCodexProvider, isLocalEndpoint, isProcessProvider, isRunnerAllowedCommand } from '../../utils/providers';
import { PROVIDER_FIELD_RANGES } from './providerFormData';

export default function ProviderConnectionTab({
  provider, formData, setFormData, capabilityProvider, allProviders, onEditProvider, runnerAllowedCommands,
  isDerived, converting, onConvertToDerived, canPairModes, alsoTui, setAlsoTui, createsModePair, tuiArgs, setTuiArgs,
}) {
  const isClaudeTui = formData.type === 'tui'
    && isClaudeCommandProvider({ ...provider, ...formData, id: provider?.id });

  return (
    <div className="space-y-4">
      {isDerived && (
        <Banner tone="info" icon={Link2}>
          <p>
            Derived from service <code className="font-mono">{provider.serviceId}</code> via{' '}
            <code className="font-mono">{provider.harnessId}</code> ({provider.method}). The command, endpoint,
            API key, backend environment and model catalog come from that service and are refreshed on every
            save. To edit this service's credentials, open{' '}
            <Link to={`/ai/services/${encodeURIComponent(provider.serviceId)}`} className="text-port-accent hover:underline">
              service settings for {provider.serviceId}
            </Link>. Name, arguments, timeouts, model pins, effort and generation settings are this preset's own.
          </p>
        </Banner>
      )}
      {provider && !isDerived && provider.presetDerivable && (
        <Banner tone="info" icon={Link2}>
          <p>
            This preset holds its own copy of a service's endpoint and credentials. Converting it derives those
            from the service it already runs on, so a change to the service reaches it automatically.
          </p>
          <button
            type="button"
            onClick={onConvertToDerived}
            disabled={converting}
            className="mt-2 px-3 py-1.5 text-sm rounded-lg border border-port-accent/50 text-port-accent hover:bg-port-accent/10 disabled:opacity-50"
          >
            {converting ? 'Converting…' : 'Convert to derived preset'}
          </button>
        </Banner>
      )}
      <FormField label="Name *">
        <input
          type="text"
          value={formData.name}
          onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
          required
          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
        />
      </FormField>

      {/* Connection-owned fields (type, command, endpoint, key, inline
          bootstrap) are the SERVICE's on a derived preset (#7565): the
          server re-materializes them on every save and refuses an edit
          that would move one, so the form shows none of them (#7567).
          The values stay in `formData` untouched, which is what keeps
          the per-tab validation satisfied. */}
      {!isDerived && (
      <FormField label="Type *">
        <select
          value={formData.type}
          onChange={(e) => setFormData(prev => ({ ...prev, type: e.target.value }))}
          className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
        >
          <option value="cli">CLI</option>
          <option value="tui">TUI</option>
          <option value="api">API</option>
        </select>
      </FormField>
      )}

      {(formData.type === 'cli' || formData.type === 'tui') && (
        <>
          {!isDerived && (
          <FormField label="Command *">
            <input
              type="text"
              value={formData.command}
              onChange={(e) => setFormData(prev => ({ ...prev, command: e.target.value }))}
              placeholder={formData.type === 'tui' ? 'codex' : 'claude'}
              required={formData.type === 'cli' || formData.type === 'tui'}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
            />
            {/* Informational only — an off-allowlist command saves fine and runs
                fine in direct-spawn mode; it just can't be launched by the CoS
                Agent Runner. Rejecting the save would break that valid config. */}
            {isRunnerAllowedCommand(formData.command, runnerAllowedCommands) === false && (
              <Banner tone="warning" icon={AlertTriangle} className="mt-2">
                <p>
                  <code className="font-mono break-all">{formData.command}</code> is not on the CoS Agent Runner’s
                  command allowlist, so <code className="font-mono">/spawn</code> and{' '}
                  <code className="font-mono">/spawn-tui</code> will refuse it. Saving is fine — the provider still
                  runs in direct-spawn mode and everywhere else.
                </p>
                <p className="mt-1 text-port-warning/80 break-words">
                  Allowlisted: {runnerAllowedCommands.join(', ')}
                </p>
              </Banner>
            )}
          </FormField>
          )}

          <FormField label="Arguments (space-separated)">
            <input
              type="text"
              value={formData.args}
              onChange={(e) => setFormData(prev => ({ ...prev, args: e.target.value }))}
              placeholder={formData.type === 'tui' ? '--dangerously-skip-permissions' : '--print -p'}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
            />
          </FormField>

          {/* Most coding harnesses run both headless and interactively.
              PortOS stores one execution mode per record, so configuring
              both used to mean adding the same command twice and hoping
              the two records matched closely enough to be treated as one
              harness. Checking this mints the pair from this one form. */}
          {canPairModes && (
            <div>
              <label htmlFor="provider-also-tui" className="flex items-start gap-2 text-sm text-gray-300 cursor-pointer">
                <input
                  id="provider-also-tui"
                  type="checkbox"
                  checked={alsoTui}
                  onChange={(e) => setAlsoTui(e.target.checked)}
                  className="mt-1"
                />
                <span>
                  This command also runs as a TUI
                  <span className="block text-xs text-gray-500">
                    Creates both modes from these shared provider and model settings. The TUI keeps its
                    own arguments and prompt timing.
                  </span>
                </span>
              </label>
            </div>
          )}

          {createsModePair && (
            <FormField label="TUI Arguments (space-separated)">
              <input
                type="text"
                value={tuiArgs}
                onChange={(e) => setTuiArgs(e.target.value)}
                placeholder="--dangerously-skip-permissions"
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
              />
            </FormField>
          )}

          {/* Generic support for a harness whose auth is provisioned by an
              external CLI at spawn time — e.g. a company-internal tool that
              mints a short-lived token for a proxy and execs the harness
              itself — instead of a static API key PortOS stores. When set,
              PortOS spawns the bootstrap command in front of the harness
              invocation above, exactly as typing `<bootstrap> run <harness>
              ...` would. Setup Command is shown for the user to run
              themselves; PortOS never executes it. */}
          {!isDerived && (
          <>
          <p className="text-sm text-gray-400 -mb-1">Credential Bootstrap (optional)</p>
          <FormField label="Setup Command" compact>
            <input
              type="text"
              value={formData.credentialBootstrapSetupCommand}
              onChange={(e) => setFormData(prev => ({ ...prev, credentialBootstrapSetupCommand: e.target.value }))}
              placeholder="One-time step shown to you, e.g. npm install -g @your-org/token-cli"
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
            />
          </FormField>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <FormField label="Bootstrap Command" compact>
              <input
                type="text"
                value={formData.credentialBootstrapCommand}
                onChange={(e) => setFormData(prev => ({ ...prev, credentialBootstrapCommand: e.target.value }))}
                placeholder="e.g. token-cli"
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
              />
            </FormField>
            <FormField label="Bootstrap Args" compact>
              <input
                type="text"
                value={formData.credentialBootstrapArgs}
                onChange={(e) => setFormData(prev => ({ ...prev, credentialBootstrapArgs: e.target.value }))}
                placeholder="e.g. run"
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
              />
            </FormField>
            <FormField label="Harness ID (optional)" compact>
              <input
                type="text"
                value={formData.credentialBootstrapHarnessId}
                onChange={(e) => setFormData(prev => ({ ...prev, credentialBootstrapHarnessId: e.target.value }))}
                placeholder={`Defaults to Command above (${formData.command || 'e.g. claude'})`}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
              />
            </FormField>
            <FormField label="Args Separator (optional)" compact>
              <input
                type="text"
                value={formData.credentialBootstrapArgsSeparator}
                onChange={(e) => setFormData(prev => ({ ...prev, credentialBootstrapArgsSeparator: e.target.value }))}
                placeholder="e.g. --"
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
              />
            </FormField>
          </div>
          <FormField label="Review credential command (optional)" compact>
            <textarea
              id="provider-bootstrap-env-command"
              value={formData.credentialBootstrapEnvCommand}
              onChange={(e) => setFormData(prev => ({ ...prev, credentialBootstrapEnvCommand: e.target.value }))}
              placeholder={'token-cli\nprint-env'}
              rows={3}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
            />
          </FormField>
          <p className="text-xs text-gray-500">
            Optional, and only for tool-free reviews. Leave it empty unless this app
            PRINTS credentials instead of running the harness itself — a review already
            runs through the wrap above, so an ordinary bootstrap app needs nothing here.
            Enter the executable, then one argument per line (no shell quoting).
            It must print KEY=value lines for provider authentication; JSON and other lines are ignored.
            Only recognized provider credentials and API endpoints are passed to the reviewer.
            Credentials are cached in memory for one minute. Do not put secrets in command arguments.
          </p>
          <p className="text-xs text-gray-500">
            For a CLI that provisions its own short-lived credential (e.g. a token for a proxy) and then
            runs the harness itself. <strong>Setup Command</strong> is a one-time step shown to you —
            PortOS never runs it. When a Bootstrap Command is set, PortOS spawns it in front of the harness
            (<code>{formData.credentialBootstrapCommand || '<bootstrap>'} {formData.credentialBootstrapArgs}{' '}
            {formData.credentialBootstrapHarnessId || formData.command || '<harness>'}{' '}
            {formData.credentialBootstrapArgsSeparator} …</code>) instead of the harness directly, and never
            routes this provider through the CoS Agent Runner (its fixed list of known harness binaries has
            no way to recognize a custom bootstrap binary). <strong>Harness ID</strong> overrides what PortOS calls the harness
            when the bootstrap CLI uses its own name for it instead of the binary above (e.g.{' '}
            <code>claude-code</code> rather than <code>claude</code>).{' '}
            <strong>Args Separator</strong> (e.g. <code>--</code>) is inserted before the harness's own
            arguments when the bootstrap CLI needs its flags kept apart from the harness's.
            Bootstrap Args are stored and shown in clear text (agent records, run transcripts, the shell
            line typed for a TUI session) — put a secret in Environment Variables marked secret, never here.{' '}
            <strong>Your bootstrap CLI should <code>exec</code> the harness, or forward the signals it
            receives to it.</strong> Stop, timeout and cancel signal the wrapped spawn's whole process
            group, so a wrapper that forks is still taken down with its harness — but a wrapper that
            re-parents the harness out of that group, or traps signals without passing them on, can leave
            it running after PortOS has finished the run.
          </p>
          </>
          )}

          {/* The CLI/TUI backends that can authenticate: the vLLM compose
              stack is started with VLLM_API_KEY, so without this field
              there is nowhere to put it and the container 401s every
              model refresh and every run. Reads `capabilityProvider`
              because `vllmBacked` is a stored marker, not a form field.
              SGLang has its own field below — its key is OPTIONAL (only
              set when the operator ran `--api-key`), so the two cannot
              share one placeholder without telling half the operators to
              paste a secret that does not exist. */}
          {!isDerived && capabilityProvider?.vllmBacked && (
            <FormField label="API Key">
              <input
                type="password"
                value={formData.apiKey}
                onChange={(e) => setFormData(prev => ({ ...prev, apiKey: e.target.value }))}
                placeholder={provider?.hasApiKey ? 'Key set — leave blank to keep' : 'Paste VLLM_API_KEY from the stack’s .env'}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
              />
              <p className="text-xs text-gray-500 mt-1">
                The <code>VLLM_API_KEY</code> your compose stack was started with. PortOS puts it on the
                spawned OpenCode provider and on the model-refresh probe; the container rejects both without it.
              </p>
            </FormField>
          )}

          {!isDerived && capabilityProvider?.sglangBacked && (
            <FormField label="API Key (optional)">
              <input
                type="password"
                value={formData.apiKey}
                onChange={(e) => setFormData(prev => ({ ...prev, apiKey: e.target.value }))}
                placeholder={provider?.hasApiKey ? 'Key set — leave blank to keep' : 'Only if you started SGLang with --api-key'}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
              />
              <p className="text-xs text-gray-500 mt-1">
                SGLang serves unauthenticated unless you started it with <code>--api-key</code>. Leave this
                blank in that case — PortOS attaches a key only when one is set.
                {isClaudeCommandProvider(capabilityProvider)
                  ? <> This <strong>Claude</strong> harness reads it for the model-refresh probe only; the
                    credential its runs authenticate with is <code>ANTHROPIC_AUTH_TOKEN</code> under
                    Environment Variables, so set that to the same key too.</>
                  : <> It rides both the spawned OpenCode provider and the model-refresh probe.</>}
              </p>
            </FormField>
          )}

          {formData.type === 'cli' && (
            <FormField label="Headless Args (for simple prompt tasks)">
              <input
                type="text"
                value={formData.headlessArgs}
                onChange={(e) => setFormData(prev => ({ ...prev, headlessArgs: e.target.value }))}
                placeholder='--no-session-persistence --disable-slash-commands --tools ""'
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
              />
              <p className="text-xs text-gray-500 mt-1">
                Extra CLI flags for lightweight prompt-in/text-out mode (brain classifier, etc.)
              </p>
            </FormField>
          )}

          {(formData.type === 'tui' || createsModePair) && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <FormField label="Prompt Paste Delay (ms)">
                <input
                  type="number"
                  min={PROVIDER_FIELD_RANGES.tuiPromptDelayMs.min}
                  max={PROVIDER_FIELD_RANGES.tuiPromptDelayMs.max}
                  value={formData.tuiPromptDelayMs}
                  onChange={(e) => setFormData(prev => ({ ...prev, tuiPromptDelayMs: e.target.value }))}
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
                />
              </FormField>
              <p className="sm:col-span-2 text-xs text-gray-500">
                TUI providers stay attached while the provider is silent; they finish on the completion sentinel, process exit, or explicit failure.
              </p>
            </div>
          )}
          {isClaudeTui && (
            <div className="space-y-1">
              <label htmlFor="lowPriorityOnUsageLimit" className="flex items-start gap-2 cursor-pointer">
                <input
                  id="lowPriorityOnUsageLimit"
                  type="checkbox"
                  aria-describedby="lowPriorityOnUsageLimit-help"
                  checked={formData.lowPriorityOnUsageLimit}
                  onChange={(e) => setFormData(prev => ({ ...prev, lowPriorityOnUsageLimit: e.target.checked }))}
                  className="mt-1"
                />
                <span className="text-sm text-gray-300">
                  Continue with Claude Code&apos;s <code>/low-priority</code> mode at its session usage limit
                </span>
              </label>
              <p id="lowPriorityOnUsageLimit-help" className="text-xs text-gray-500 ml-6">
                This may use weekly allowance and pause while capacity is unavailable. Claude Code must offer the mode for that session.
              </p>
            </div>
          )}
        </>
      )}

      {formData.type === 'api' && (
        <>
          {!isDerived && (
          <>
          <FormField label="Endpoint *">
            <input
              type="url"
              value={formData.endpoint}
              onChange={(e) => setFormData(prev => ({ ...prev, endpoint: e.target.value }))}
              placeholder="http://localhost:1234/v1"
              required={formData.type === 'api'}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
            />
          </FormField>

          <FormField label="API Key">
            <input
              type="password"
              value={formData.apiKey}
              onChange={(e) => setFormData(prev => ({ ...prev, apiKey: e.target.value }))}
              placeholder={provider?.hasApiKey
                ? 'Key set — leave blank to keep'
                : isLocalEndpoint(formData.endpoint)
                  ? 'Not needed for local endpoints'
                  : 'Paste the key from your provider dashboard'}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
            />
            <p className="text-xs text-gray-500 mt-1">
              This field is the only place API providers read a key from — it's stored on this
              provider and sent as an <code>Authorization: Bearer</code> header on every request.
              No environment variable is involved. Hosted APIs (Cerebras, Grok, NVIDIA, OrcaRouter, OpenRouter, …) require
              one; local backends (Ollama, LM Studio) don't.
            </p>
          </FormField>
          </>
          )}

          <FormField label="Custom endpoint">
            <label htmlFor="allowCustomEndpoint" className="flex items-start gap-2 cursor-pointer">
              <input
                id="allowCustomEndpoint"
                type="checkbox"
                checked={formData.allowCustomEndpoint}
                onChange={(e) => setFormData(prev => ({ ...prev, allowCustomEndpoint: e.target.checked }))}
                className="mt-1"
              />
              <span className="text-sm text-gray-300">
                Allow sending the API key to this custom (non-local, non-allowlisted) endpoint.
                Loopback/LAN and known providers (OpenAI, Anthropic, OpenRouter, …) are always allowed;
                cloud-metadata hosts are always blocked. Leave off unless you trust this host.
              </span>
            </label>
          </FormField>
        </>
      )}

      {isCodexProvider({ ...provider, ...formData, id: provider?.id }) && isProcessProvider(formData) && (
        <FormField label="Codex user config">
          <label htmlFor="ignoreUserConfig" className="flex items-start gap-2 cursor-pointer">
            <input
              id="ignoreUserConfig"
              type="checkbox"
              checked={formData.ignoreUserConfig}
              onChange={(e) => setFormData(prev => ({ ...prev, ignoreUserConfig: e.target.checked }))}
              className="mt-1"
            />
            <span className="text-sm text-gray-300">
              Ignore <code>~/.codex/config.toml</code> when PortOS runs this provider
              (<code>--ignore-user-config</code>). Leave off to keep today’s behavior. Turn it on when a
              third-party bridge has re-pointed Codex model routing and you want PortOS runs pinned to
              the account this card reports on.
            </span>
          </label>
        </FormField>
      )}

      {isCodexProvider({ ...provider, ...formData, id: provider?.id }) && isProcessProvider(formData) && (
        <FormField label="Codex authentication">
          <select
            id="codexAuthMode"
            value={formData.codexAuthMode}
            onChange={(e) => setFormData(prev => ({ ...prev, codexAuthMode: e.target.value }))}
            className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white"
          >
            <option value="">Codex default (its own login state)</option>
            <option value="chatgpt">ChatGPT subscription</option>
            <option value="api">API key (API billing)</option>
          </select>
          <span className="text-xs text-gray-500 mt-1 block">
            Pins Codex to one login method (<code>forced_login_method</code>). Some models are only
            available to one method; ChatGPT subscription and API-key access are billed separately.
          </span>
        </FormField>
      )}

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={formData.enabled}
          onChange={(e) => setFormData(prev => ({ ...prev, enabled: e.target.checked }))}
          className="w-4 h-4 rounded border-port-border bg-port-bg"
        />
        <span className="text-sm text-gray-400">Enabled</span>
      </label>

      {provider?.textTransport === 'codex-app-server' && (
        <div className="max-w-3xl rounded-lg border border-port-warning/40 bg-port-warning/10 p-3 space-y-3">
          <div className="space-y-1">
            <p className="text-sm font-medium text-port-warning">ChatGPT subscription text calls</p>
            <p className="text-xs text-gray-300">
              PortOS blocks writes, network access, MCP servers, and web search for these calls.
              Codex can still read local files by absolute path, so untrusted prompt text could make
              a saved response contain local file contents.
            </p>
          </div>
          <div className="space-y-2">
            <div className="flex items-start gap-2">
              <input
                id="codex-text-read-risk"
                type="checkbox"
                checked={formData.textTransportReadRiskAcknowledged}
                onChange={(e) => setFormData(prev => ({
                  ...prev,
                  textTransportReadRiskAcknowledged: e.target.checked,
                  textTransportEnabled: e.target.checked ? prev.textTransportEnabled : false,
                }))}
                className="mt-0.5 w-4 h-4 rounded border-port-border bg-port-bg"
              />
              <label htmlFor="codex-text-read-risk" className="text-sm text-gray-300">
                I understand that Codex may read local files during generic text calls.
              </label>
            </div>
            <div className="flex items-start gap-2">
              <input
                id="codex-text-transport-enabled"
                type="checkbox"
                checked={formData.textTransportEnabled}
                disabled={!formData.textTransportReadRiskAcknowledged}
                onChange={(e) => setFormData(prev => ({ ...prev, textTransportEnabled: e.target.checked }))}
                className="mt-0.5 w-4 h-4 rounded border-port-border bg-port-bg disabled:opacity-50"
              />
              <label
                htmlFor="codex-text-transport-enabled"
                className={`text-sm ${formData.textTransportReadRiskAcknowledged ? 'text-gray-300' : 'text-gray-500'}`}
              >
                Allow this provider to serve generic text calls.
              </label>
            </div>
          </div>
        </div>
      )}

      {gatewayForProvider(provider) && (
        <GatewayKeyHint
          gateway={gatewayForProvider(provider)}
          sibling={allProviders.find(p => p.id === gatewayForProvider(provider).id)}
          onEdit={onEditProvider}
        />
      )}
    </div>
  );
}
