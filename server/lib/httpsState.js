/**
 * Captures whether PortOS booted with HTTPS active.
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
