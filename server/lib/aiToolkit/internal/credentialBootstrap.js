/**
 * The PURE argv shape of a provider's credential bootstrap: the external CLI
 * spawned in front of a CLI/TUI harness whose auth it provisions. Dependency-free
 * so the host's `server/lib/credentialBootstrap.js` and toolkit model probes
 * share it (a bare probe answers for the wrong account). Imports nothing.
 */

/** True when a provider names a bootstrap CLI to wrap its harness spawn. */
export function hasCredentialBootstrap(provider) {
  return typeof provider?.credentialBootstrap?.command === 'string' && provider.credentialBootstrap.command.length > 0;
}

/**
 * Shape: `<bootstrap.command> <bootstrap.args...> <harnessId> [<argsSeparator>] <args...>`.
 * `harnessId` is the wrapper's own name for the harness (default: the binary).
 * `wrapped` means the bootstrap CLI is the direct child: a forking wrapper
 * survives a per-pid signal, so the host's teardown needs a process group.
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
