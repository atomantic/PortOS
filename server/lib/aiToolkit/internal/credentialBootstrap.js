/**
 * The PURE argv shape of a provider's credential bootstrap: what to spawn when
 * a CLI/TUI provider's auth is provisioned by an external CLI at spawn time
 * rather than by a static `apiKey` PortOS stores.
 *
 * It lives in this directory — the lowest, dependency-free layer — because
 * BOTH sides need it and only this direction is legal: the vendored toolkit may
 * not import out to PortOS modules, while `server/lib/credentialBootstrap.js`
 * (the host's spawn-site helper, which adds the public-review safety skip and
 * the Windows shim resolution) imports this leaf rather than restating the
 * shape. The toolkit's own child spawns — the model-catalog probes behind the
 * provider card's **Refresh Models** button — call it directly, because a probe
 * that runs the bare harness runs it with no credential and answers for the
 * wrong account (or fails outright), exactly as a bare run would.
 *
 * Imports nothing.
 */

/** True when a provider names a bootstrap CLI to wrap its harness spawn. */
export function hasCredentialBootstrap(provider) {
  return typeof provider?.credentialBootstrap?.command === 'string' && provider.credentialBootstrap.command.length > 0;
}

/**
 * The command+args to actually spawn for this provider: the bootstrap CLI in
 * front of the harness invocation when one is configured, or the harness
 * invocation unchanged otherwise. Never touches the filesystem or PATH.
 *
 * Shape: `<bootstrap.command> <bootstrap.args...> <harnessId> [<bootstrap.argsSeparator>] <args...>`.
 *
 * `argsSeparator` exists because a wrapper CLI commonly needs its own flags
 * kept apart from the harness's — e.g. `<bootstrap> run <harness> -- <harness
 * args>` — and without a configurable separator the harness's own flags would
 * be parsed as the bootstrap CLI's. `harnessId` exists because a bootstrap
 * CLI's own name for a harness is not always the binary PortOS spawns (e.g.
 * `claude-code` where `provider.command` is the literal binary `claude`); it
 * defaults to the harness binary.
 *
 * `wrapped` says whether the bootstrap CLI is now the direct child. The host's
 * teardown keys on it (`server/lib/credentialBootstrap.js#needsProcessGroup`,
 * #7496): a wrapper that forks rather than execs the harness would survive a
 * per-pid signal, so a wrapped spawn needs its own process group.
 *
 * @param {{credentialBootstrap?: {command: string, args?: string[], harnessId?: string, argsSeparator?: string}}|null|undefined} provider
 * @param {string} command - the harness binary PortOS would otherwise spawn
 * @param {string[]} [args] - the harness's own argv
 * @returns {{command: string, args: string[], wrapped: boolean}}
 */
export function composeBootstrapSpawn(provider, command, args) {
  const harnessArgs = Array.isArray(args) ? args : [];
  if (!hasCredentialBootstrap(provider)) return { command, args: harnessArgs, wrapped: false };
  const bootstrap = provider.credentialBootstrap;
  const harnessId = (typeof bootstrap.harnessId === 'string' && bootstrap.harnessId) || command;
  const separator = (typeof bootstrap.argsSeparator === 'string' && bootstrap.argsSeparator && harnessArgs.length > 0)
    ? [bootstrap.argsSeparator] : [];
  return {
    command: bootstrap.command,
    args: [...(Array.isArray(bootstrap.args) ? bootstrap.args : []), harnessId, ...separator, ...harnessArgs],
    wrapped: true,
  };
}
