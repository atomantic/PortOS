/**
 *  Pi CLI argv conventions. See https://pi.dev/docs/latest/usage.
 *
 * Pi command identity, headless/TUI arguments, and positional prompt delivery. A Pi record with an
 * OpenAI-compatible `endpoint` and no `--provider` pin (`isPiEndpointProvider`) runs against that
 * endpoint through the shipped `pi/portosEndpointExtension.js`: the argv builders append `--extension
 * <path> --provider portos-endpoint` and `buildPiEndpointEnvVars` (layered by
 * `cliChildEnv.js#composeProviderEnv`) passes the base URL, models and key, so PortOS never writes
 * Pi's user-owned `models.json`.
 */
import { fileURLToPath } from 'node:url';
import { PI_COMMAND, isPiCommand } from './aiToolkit/internal/pi.js';
import { argvHasFlag, hasModelFlag, buildEffortArgs } from './provider/providerModels.js';

export { PI_COMMAND, isPiCommand } from './aiToolkit/internal/pi.js';

/** Provider name the shipped endpoint extension registers (see pi/portosEndpointExtension.js). */
export const PI_ENDPOINT_PROVIDER = 'portos-endpoint';
export const PI_ENDPOINT_EXTENSION_PATH = fileURLToPath(new URL('./pi/portosEndpointExtension.js', import.meta.url));

/**
 * A Pi record pointed at an OpenAI-compatible `endpoint` rather than a
 * built-in Pi provider. Routes materialized for a service Pi ships (nvidia,
 * openrouter, …) also record `endpoint`, but carry `--provider <name>` in
 * their argv, which keeps them on Pi's own provider.
 */
export function isPiEndpointProvider(provider) {
  return isPiCommand(provider?.command)
    && typeof provider?.endpoint === 'string' && provider.endpoint.trim() !== ''
    && !argvHasFlag(provider?.args || [], ['--provider']);
}

function withPiEndpointArgs(args, provider) {
  if (!isPiEndpointProvider(provider) || argvHasFlag(args, ['--provider'])) return args;
  return [...args, '--extension', PI_ENDPOINT_EXTENSION_PATH, '--provider', PI_ENDPOINT_PROVIDER];
}

/**
 * Spawn env the endpoint extension reads. Declares the record's models plus
 * this run's model, so whichever `--model` the spawner passes resolves. Empty
 * for every other record.
 */
export function buildPiEndpointEnvVars(provider, model = null) {
  if (!isPiEndpointProvider(provider)) return {};
  const ids = [...(Array.isArray(provider.models) ? provider.models : []), provider.defaultModel, model]
    .filter((id) => typeof id === 'string' && id.trim());
  return {
    PORTOS_PI_ENDPOINT_BASE_URL: provider.endpoint.trim(),
    PORTOS_PI_ENDPOINT_MODELS: JSON.stringify([...new Set(ids)]),
    ...(provider.name ? { PORTOS_PI_ENDPOINT_NAME: String(provider.name) } : {}),
    ...(provider.apiKey ? { PORTOS_PI_ENDPOINT_API_KEY: String(provider.apiKey) } : {}),
  };
}

export function ensurePiTuiArgs(baseArgs = [], provider = null) {
  const args = [...baseArgs];
  if (!argvHasFlag(args, ['--approve', '-a', '--no-approve', '-na'])) args.push('--approve');
  return withPiEndpointArgs(args, provider);
}

export function ensurePiHeadlessArgs(baseArgs = [], model, effort, provider = null) {
  const args = ensurePiTuiArgs(baseArgs, provider);
  if (!argvHasFlag(args, ['--print', '-p'])) args.push('--print');
  if (model && !hasModelFlag(args)) args.push('--model', model);
  args.push(...buildEffortArgs(effort, { command: PI_COMMAND }, args));
  return args;
}

export function preparePiPrompt(args = [], prompt = '') {
  // Prefix prevents pi interpreting a leading @ as a file attachment; -- ends
  // option parsing so a prompt cannot inject CLI flags.
  return { args: [...args, '--', `Task:\n${prompt}`], useStdin: false, cleanup: () => {} };
}
