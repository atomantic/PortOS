/** Add disabled Pi presets without changing configured providers or starting work. */
import { makeProviderSeedMigration } from './_lib.js';

export default makeProviderSeedMigration({
  label: 'Pi Coding Agent',
  defs: [
  {
    "id": "pi-cli",
    "name": "Pi Coding Agent CLI",
    "type": "cli",
    "command": "pi",
    "args": [
      "--print",
      "--approve"
    ],
    "models": [],
    "defaultModel": null,
    "timeout": 600000,
    "enabled": false,
    "envVars": {},
    "secretEnvVars": []
  },
  {
    "id": "pi-tui",
    "name": "Pi Coding Agent TUI",
    "type": "tui",
    "command": "pi",
    "args": [
      "--approve"
    ],
    "models": [],
    "defaultModel": null,
    "timeout": 600000,
    "enabled": false,
    "envVars": {},
    "secretEnvVars": []
  }
],
});
