/**
 * The two credential/privacy notices a provider surface renders: the Grok Build
 * CLI's repo-upload disclosure and a gateway-backed OpenCode wrapper's "the key
 * lives on the sibling API provider" hint.
 *
 * Shared because both the provider CARD and the provider EDITOR show them — the
 * card so the state is visible at a glance, the editor so the user reads it
 * before enabling. Keeping one copy is what stops the two from drifting.
 */

// Privacy disclosure for the Grok Build CLI/TUI: its harness uploads the entire
// working repo to xAI (GCP) as it works unless the user opts out. Shown both on
// the provider card and in the create/edit form (before enabling) — see
// isGrokBuildCli for which providers match.
export function GrokUploadWarning({ className = '' }) {
  return (
    <div className={`text-xs rounded-md border border-port-warning/40 bg-port-warning/10 text-port-warning px-2.5 py-2 leading-relaxed ${className}`}>
      ⚠️ The Grok harness uploads your <span className="font-semibold">entire working repo</span> to
      xAI (GCP) as it works. To keep your code local, add the following to{' '}
      <code className="font-mono">~/.grok/config.toml</code> before enabling this provider:
      <pre className="mt-1.5 whitespace-pre rounded bg-port-bg/60 px-2 py-1.5 font-mono text-[11px] text-port-warning">{`[harness]
disable_codebase_upload = true`}</pre>
    </div>
   );
}

// A gateway-backed OpenCode wrapper (opencode-orcarouter / opencode-openrouter
// and their -tui twins) keeps no key of its own — at spawn time the server
// copies the key from the sibling API provider whose id equals the gateway id.
// This answers "where do I put the API key?" from the card/form: it's on the
// API provider, not here. `gateway` is a row of PROVIDER_GATEWAYS
// (client/src/utils/providers.js), so the copy names the right gateway rather
// than hardcoding one.
export function GatewayKeyHint({ gateway, sibling, className = '', onEdit }) {
  if (!gateway) return null;
  const hasKey = Boolean(sibling?.hasApiKey);
  return (
    <div className={`text-xs rounded-md border border-port-border bg-port-bg/60 px-2.5 py-2 leading-relaxed ${className}`}>
      <span className="text-gray-300">
        API key is inherited from the <code className="font-mono">{gateway.label}</code> API provider
        {" "}at run time — this wrapper has no key field of its own.
      </span>
      <p className="mt-1 text-gray-400">
        You do not need to add an environment variable. PortOS supplies{' '}
        <code className="font-mono">{gateway.apiKeyEnv}</code> to OpenCode automatically.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {hasKey ? (
          <span className="text-port-success">{gateway.label} key: set</span>
        ) : (
          <span className="text-port-warning">{gateway.label} key: not set</span>
        )}
        {sibling && onEdit && (
          <button
            type="button"
            onClick={() => onEdit(sibling)}
            className="text-port-accent hover:text-port-accent/80 underline underline-offset-2"
          >
            Edit {gateway.label} API provider
          </button>
        )}
      </div>
    </div>
   );
}
