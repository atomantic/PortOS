/** Add disabled Hermes Agent presets without changing configured providers or starting work. */
import { makeProviderSeedMigration } from './_lib.js';

export default makeProviderSeedMigration({
  label: 'Hermes Agent',
  defs: [
    {
      "id": "hermes-cli",
      "name": "Hermes Agent CLI",
      "type": "cli",
      "command": "hermes",
      "args": [
        "chat",
        "--oneshot",
        "--quiet",
        "--yolo"
      ],
      "models": [],
      "defaultModel": null,
      "timeout": 600000,
      "enabled": false,
      "envVars": {},
      "secretEnvVars": [],
      "headlessArgs": []
    },
    {
      "id": "hermes-tui",
      "name": "Hermes Agent TUI",
      "type": "tui",
      "command": "hermes",
      "args": [
        "--tui",
        "--yolo"
      ],
      "models": [],
      "defaultModel": null,
      "timeout": 600000,
      "enabled": false,
      "envVars": {},
      "secretEnvVars": [],
      "tuiPromptDelayMs": 2500
    }
  ],
});
