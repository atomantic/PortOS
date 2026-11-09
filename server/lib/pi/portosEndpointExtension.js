/**
 * Pi extension PortOS loads (`--extension`) for a Pi provider record that
 * names an OpenAI-compatible `endpoint` instead of a built-in Pi provider.
 *
 * Pi reaches a custom endpoint only through `models.json` in its agent dir, a
 * user-owned file PortOS does not write. Registering the endpoint from an
 * extension keeps that file (and the user's auth, skills and settings)
 * untouched. Everything comes from the spawn env built by
 * `buildPiEndpointEnvVars` in `server/lib/pi.js`; with no base URL the
 * extension registers nothing.
 *
 * Loaded by Pi, not by PortOS: no imports, so it runs from any install path.
 */
export default function portosEndpointExtension(pi) {
  const baseUrl = process.env.PORTOS_PI_ENDPOINT_BASE_URL;
  if (!baseUrl) return;
  let ids = [];
  try {
    ids = JSON.parse(process.env.PORTOS_PI_ENDPOINT_MODELS || '[]');
  } catch {
    ids = [];
  }
  const models = (Array.isArray(ids) ? ids : [])
    .filter((id) => typeof id === 'string' && id.trim())
    .map((id) => ({
      type: 'chat',
      id,
      name: id,
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 16384,
    }));
  // Must equal PI_ENDPOINT_PROVIDER in server/lib/pi.js (the `--provider` PortOS passes).
  pi.registerProvider('portos-endpoint', {
    name: process.env.PORTOS_PI_ENDPOINT_NAME || 'PortOS endpoint',
    baseUrl,
    // `$NAME` form so a key starting with `!` is never run as a command. Pi
    // hides a model whose provider has no credential, so a keyless local
    // daemon still gets a placeholder.
    apiKey: process.env.PORTOS_PI_ENDPOINT_API_KEY ? '$PORTOS_PI_ENDPOINT_API_KEY' : 'none',
    api: 'openai-completions',
    models,
  });
}
