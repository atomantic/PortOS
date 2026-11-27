/**
 * Start llama-server with PortOS: replay the last explicit launch line at boot
 * when `settings.localLlm.llama.autoStart` is on, and reconcile at toggle time.
 *
 * This starts a local process from a saved choice; it makes no model call, so
 * it stays inside the boot rule (boot reads disk). The launch line is written by
 * `llamaServerManager.startLlamaServer` on every explicit start, so turning this
 * on means "bring back what I last ran", never a default nobody picked.
 * It is independent of `pm2 save`: a PortOS redeploy or a PM2 dump without the
 * llama process still brings it back.
 */

const loadSettings = () => import('./settings.js');
const loadManager = () => import('./llamaServerManager.js');

/** What a boot/toggle start would do: `{ launch }` to start, else `{ skip }`. */
async function planAutoStart(deps) {
  const { getSettings } = deps.settings || await loadSettings();
  const llama = (await getSettings())?.localLlm?.llama || {};
  if (llama.autoStart !== true) return { skip: 'disabled' };
  if (!llama.launch?.model) return { skip: 'no-launch' };
  const manager = deps.manager || await loadManager();
  const status = await manager.getLlamaServerStatus();
  if (!status?.installed) return { skip: 'not-installed' };
  if (status.running) return { skip: 'running' };
  return { launch: llama.launch, manager };
}

const SKIP_LOG = {
  'no-launch': 'no saved launch line yet; start it once from the LLMs page or Voice',
  'not-installed': 'llama.cpp is not installed',
};

async function runAutoStart(deps) {
  const plan = await planAutoStart(deps);
  if (plan.skip) {
    if (SKIP_LOG[plan.skip]) console.log(`⏭️ llama-server auto-start skipped: ${SKIP_LOG[plan.skip]}`);
    return { started: false, reason: plan.skip };
  }
  console.log(`🦙 llama-server auto-start: launching ${plan.launch.alias || plan.launch.model}`);
  const launched = await plan.manager.startLlamaServer(plan.launch);
  return { started: true, reason: 'started', launched };
}

/**
 * Boot entry point. Never rejects: a failed start is logged and boot goes on.
 * @returns {Promise<{started: boolean, reason: string}>}
 */
export async function autoStartLlamaServer(deps = {}) {
  return runAutoStart(deps).catch((err) => {
    console.error(`❌ llama-server auto-start failed: ${err?.message || err}`);
    return { started: false, reason: 'failed' };
  });
}

/**
 * Save the toggle, then reconcile: turning it on while the server is down starts
 * it now, so the switch and the process agree without waiting for a reboot.
 * Turning it off leaves a running server alone. A failed start rejects (the
 * setting stays saved), so the caller can show why.
 */
export async function setLlamaServerAutoStart(enabled, deps = {}) {
  const on = enabled === true;
  const { updateSettingsWith } = deps.settings || await loadSettings();
  await updateSettingsWith((current) => ({
    ...current,
    localLlm: {
      ...current?.localLlm,
      llama: { ...current?.localLlm?.llama, autoStart: on },
    },
  }));
  const reconcile = on ? await runAutoStart(deps) : { started: false, reason: 'disabled' };
  return { autoStart: on, ...reconcile };
}
