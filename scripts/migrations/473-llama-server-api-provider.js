/**
 * Ship a disabled llama.cpp (local) API provider preset to existing installs.
 *
 * PortOS already manages `portos-llama-server` on loopback port 5568 and ships
 * an OpenCode TUI wrapper (`opencode-llama-tui`), but API consumers such as
 * Voice Mode needed a direct OpenAI-compatible API provider pointing at that
 * endpoint. This migration seeds the disabled API preset without starting
 * llama-server or touching any install that already owns `llama-server`.
 * Kept in lockstep with data.reference/providers.json and
 * server/lib/aiToolkit/defaults/providers.sample.json.
 */

import { makeProviderSeedMigration } from './_lib.js';

const LLAMA_SERVER_API = {
  id: 'llama-server',
  name: 'llama.cpp (local)',
  type: 'api',
  endpoint: 'http://127.0.0.1:5568/v1',
  apiKey: '',
  llamaBacked: true,
  models: [],
  defaultModel: null,
  timeout: 300000,
  enabled: false,
  envVars: {},
  secretEnvVars: [],
};

export default makeProviderSeedMigration({
  label: 'llama.cpp (local)',
  defs: [LLAMA_SERVER_API],
});
