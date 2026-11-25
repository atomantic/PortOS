/** Install the same disabled Splash presets on existing PortOS installs without enrolling a runtime. */

import { makeProviderSeedMigration } from './_lib.js';

const DEFS = [
  {
    "id": "splash",
    "name": "Splash (local)",
    "type": "api",
    "endpoint": "http://127.0.0.1:8001/v1",
    "apiKey": "",
    "splashBacked": true,
    "models": [
      "inkling2-mini"
    ],
    "defaultModel": "inkling2-mini",
    "timeout": 600000,
    "enabled": false,
    "envVars": {},
    "secretEnvVars": []
  },
  {
    "id": "opencode-splash",
    "name": "OpenCode · Splash (local)",
    "type": "cli",
    "command": "opencode",
    "args": [
      "run"
    ],
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
    "headlessArgs": []
  },
  {
    "id": "claude-splash",
    "name": "Claude Code · Splash (local)",
    "type": "cli",
    "command": "claude",
    "args": [
      "--print"
    ],
    "endpoint": "http://127.0.0.1:8001/v1",
    "splashBacked": true,
    "models": [
      "inkling2-mini"
    ],
    "defaultModel": "inkling2-mini",
    "timeout": 600000,
    "enabled": false,
    "envVars": {
      "ANTHROPIC_BASE_URL": "http://127.0.0.1:8001",
      "ANTHROPIC_AUTH_TOKEN": "splash",
      "ANTHROPIC_MODEL": "inkling2-mini",
      "ANTHROPIC_DEFAULT_OPUS_MODEL": "inkling2-mini",
      "ANTHROPIC_DEFAULT_SONNET_MODEL": "inkling2-mini",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL": "inkling2-mini",
      "ANTHROPIC_SMALL_FAST_MODEL": "inkling2-mini",
      "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
      "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "65536"
    },
    "secretEnvVars": [
      "ANTHROPIC_AUTH_TOKEN"
    ],
    "headlessArgs": [
      "--no-session-persistence",
      "--disable-slash-commands",
      "--tools",
      ""
    ]
  }
];

export default makeProviderSeedMigration({ label: 'Splash', defs: DEFS });
