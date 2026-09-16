/**
 * Ship the disabled Kilo Code and OpenChamber harness presets to existing
 * installs, so the two new harnesses are reachable without a hand-typed record.
 *
 * Both are DISABLED and this migration installs nothing: it downloads no CLI,
 * starts no server, and contacts no provider (AGENTS.md, "No cold-bootstrap LLM
 * calls"). `models` ships EMPTY and `defaultModel` null — Kilo serves whatever
 * the user's own `/connect` credentials reach, and OpenChamber serves whatever
 * its runtime is signed in to, so neither list can be guessed here. Kilo's is
 * filled by an explicit refresh (`kilo models`, via Models → Harnesses).
 *
 * The argv each preset ships is the one the vendor rows build, so a user who
 * never touches these records runs the same command line PortOS would inject:
 *
 *   - `kilo run --auto` / `kilo --auto` — `--auto` is what lets an unattended
 *     run get past Kilo's permission prompts (see `server/lib/kilo.js`).
 *   - `openchamber session create --wait --last-assistant --quiet` — the
 *     control-plane action that runs a prompt and prints the answer. `--dir`
 *     and `--prompt` are deliberately ABSENT: they are spliced in at spawn time
 *     from the run's real working directory (see `server/lib/openchamber.js`).
 *
 * There is no OpenChamber `tui` preset. Its interactive surface is a web app and
 * the bare binary starts its SERVER, so a PTY record would launch a daemon and
 * call it an agent.
 *
 * An install that already owns one of these ids is left untouched, so a user who
 * renamed or disabled the row keeps their record.
 */
import { makeProviderSeedMigration } from './_lib.js';

export default makeProviderSeedMigration({
  label: 'Kilo Code and OpenChamber',
  defs: [
    {
      id: 'kilo-cli',
      name: 'Kilo Code CLI',
      type: 'cli',
      command: 'kilo',
      args: ['run', '--auto'],
      models: [],
      defaultModel: null,
      timeout: 600000,
      enabled: false,
      envVars: {},
      secretEnvVars: [],
    },
    {
      id: 'kilo-tui',
      name: 'Kilo Code TUI',
      type: 'tui',
      command: 'kilo',
      args: ['--auto'],
      models: [],
      defaultModel: null,
      timeout: 600000,
      enabled: false,
      envVars: {},
      secretEnvVars: [],
      tuiPromptDelayMs: 2500,
    },
    {
      id: 'openchamber-cli',
      name: 'OpenChamber',
      type: 'cli',
      command: 'openchamber',
      args: ['session', 'create', '--wait', '--last-assistant', '--quiet'],
      models: [],
      defaultModel: null,
      timeout: 600000,
      enabled: false,
      envVars: {},
      secretEnvVars: [],
    },
  ],
});
