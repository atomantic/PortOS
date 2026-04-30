/**
 * Captures whether PortOS booted with HTTPS active. The decision is made once
 * at server start (see lib/tailscale-https.js) — `createTailscaleServers`
 * inspects cert presence and returns an http or https server accordingly.
 * After that, the listener type is frozen for the life of the process.
 *
 * Consumers (e.g. certProvisioner) need this signal to decide whether
 * provisioning a new cert at runtime requires a restart. Checking cert file
 * presence isn't enough — once cert files exist, every subsequent provision
 * call would falsely report "no restart needed" even though the process is
 * still serving HTTP.
 */

let httpsEnabledAtBoot = false;
let initialized = false;

export function setHttpsEnabledAtBoot(value) {
  httpsEnabledAtBoot = Boolean(value);
  initialized = true;
}

export function getHttpsEnabledAtBoot() {
  return { value: httpsEnabledAtBoot, initialized };
}
