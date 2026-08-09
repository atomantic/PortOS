/**
 * The managed-apps registry's baseline identity — PortOS itself.
 *
 * Split out of `services/apps.js` so a module that only needs to SAY "this work
 * targets PortOS" (a CoS task's `metadata.app`, a scope check) doesn't have to
 * import the apps service — which drags in pm2, the task scheduler, streaming
 * detection and the settings graph behind it. `apps.js` re-exports the constant,
 * so every existing `import { PORTOS_APP_ID } from './apps.js'` is unchanged.
 *
 * Data only, no dependencies.
 */

/** Stable id of the baseline PortOS app — always present, never deletable. */
export const PORTOS_APP_ID = 'portos-default';
