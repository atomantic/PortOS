/**
 * Credential guidance shared by a provider card and editor: a gateway-backed
 * OpenCode wrapper's "the key lives on the sibling API provider" hint.
 *
 * Shared because both the provider CARD and the provider EDITOR show it — the
 * card so the state is visible at a glance, the editor so the user reads it
 * before enabling. Keeping one copy is what stops the two from drifting.
 */

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
  const shellClass = `text-xs rounded-md border border-port-border bg-port-bg/60 px-2.5 py-2 leading-relaxed ${className}`;
  const editLink = sibling && onEdit && (
    <button
      type="button"
      onClick={() => onEdit(sibling)}
      className="text-port-accent hover:text-port-accent/80 underline underline-offset-2"
    >
      Edit {gateway.label} API provider
    </button>
  );

  // Once the key is there, the three paragraphs explaining WHERE to put it are
  // answering a question the user no longer has — they read as an unresolved
  // setup step on a provider that is fully configured. Collapse to the status
  // plus the same edit link, which is the only part still worth acting on.
  if (hasKey) {
    return (
      <div className={`${shellClass} flex flex-wrap items-center gap-2`}>
        <span className="text-port-success">{gateway.label} API key configured</span>
        <span className="text-gray-500">— inherited by this wrapper at run time</span>
        {editLink}
      </div>
    );
  }

  return (
    <div className={shellClass}>
      <span className="text-gray-300">
        API key is inherited from the <code className="font-mono">{gateway.label}</code> API provider
        {" "}at run time — this wrapper has no key field of its own.
      </span>
      <p className="mt-1 text-gray-400">
        You do not need to add an environment variable. PortOS supplies{' '}
        <code className="font-mono">{gateway.apiKeyEnv}</code> to OpenCode automatically.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="text-port-warning">{gateway.label} key: not set</span>
        {editLink}
      </div>
    </div>
   );
}
