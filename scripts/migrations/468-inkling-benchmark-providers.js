/** Seed the disabled Splash TUI and mkserve presets on existing installs. */

import { makeProviderSeedMigration } from './_lib.js';

const DEFS = [
  {
    "id": "opencode-splash-tui",
    "name": "OpenCode · Splash TUI (local)",
    "type": "tui",
    "command": "opencode",
    "args": [],
    "endpoint": "http://127.0.0.1:8001/v1",
    "apiKey": "",
    "splashBacked": true,
    "models": [
      "inkling2-mini"
    ],
    "defaultModel": "inkling2-mini",
    "timeout": 600000,
    "enabled": false,
    "envVars": {
      "OPENCODE_CONFIG_CONTENT": "{\"permission\":\"allow\",\"provider\":{\"splash\":{\"npm\":\"@ai-sdk/openai-compatible\",\"name\":\"Splash (local)\",\"options\":{\"baseURL\":\"http://127.0.0.1:8001/v1\"}}}}"
    },
    "secretEnvVars": [],
    "tuiPromptDelayMs": 2500
  },
  {
    "id": "opencode-mkserve",
    "name": "OpenCode · mkserve (local)",
    "type": "cli",
    "command": "opencode",
    "args": [
      "run"
    ],
    "endpoint": "http://127.0.0.1:8002/v1",
    "apiKey": "",
    "mkserveBacked": true,
    "models": [
      "thinkingmachines/Inkling-2-Mini"
    ],
    "defaultModel": "thinkingmachines/Inkling-2-Mini",
    "timeout": 600000,
    "enabled": false,
    "envVars": {
      "OPENCODE_CONFIG_CONTENT": "{\"permission\":\"allow\",\"provider\":{\"mkserve\":{\"npm\":\"@ai-sdk/openai-compatible\",\"name\":\"mkserve (local)\",\"options\":{\"baseURL\":\"http://127.0.0.1:8002/v1\"}}}}"
    },
    "secretEnvVars": [],
    "headlessArgs": []
  },
  {
    "id": "opencode-mkserve-tui",
    "name": "OpenCode · mkserve TUI (local)",
    "type": "tui",
    "command": "opencode",
    "args": [],
    "endpoint": "http://127.0.0.1:8002/v1",
    "apiKey": "",
    "mkserveBacked": true,
    "models": [
      "thinkingmachines/Inkling-2-Mini"
    ],
    "defaultModel": "thinkingmachines/Inkling-2-Mini",
    "timeout": 600000,
    "enabled": false,
    "envVars": {
      "OPENCODE_CONFIG_CONTENT": "{\"permission\":\"allow\",\"provider\":{\"mkserve\":{\"npm\":\"@ai-sdk/openai-compatible\",\"name\":\"mkserve (local)\",\"options\":{\"baseURL\":\"http://127.0.0.1:8002/v1\"}}}}"
    },
    "secretEnvVars": [],
    "tuiPromptDelayMs": 2500
  },
  {
    "id": "mkserve",
    "name": "mkserve (local)",
    "type": "api",
    "endpoint": "http://127.0.0.1:8002/v1",
    "apiKey": "",
    "mkserveBacked": true,
    "models": [
      "thinkingmachines/Inkling-2-Mini"
    ],
    "defaultModel": "thinkingmachines/Inkling-2-Mini",
    "timeout": 600000,
    "enabled": false,
    "envVars": {},
    "secretEnvVars": []
  }
];

export default makeProviderSeedMigration({ label: 'Inkling agent benchmark', defs: DEFS });
