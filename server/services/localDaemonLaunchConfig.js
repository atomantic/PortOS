/**
 * Persist the launch line a local on-demand daemon (MTPLX, Slotstream) just
 * started with, so its next on-demand restart — after the idle reaper stops
 * it — replays the SAME configuration instead of falling back to a resolved
 * default.
 *
 * Generalized from `slotstreamServerManager.js`'s original `persistLaunchConfig`
 * (#8105): both managers now call this on every successful start. It lives
 * beside the managers rather than in `lib/managedDaemon.js` because it reaches
 * `services/settings.js`, and that import stays out of the daemon-mechanism
 * lib's graph (see the header of `managedDaemon.js` — `readSection` is
 * injected there for the same reason).
 */

/**
 * @param {{key: string, label: string, launch: object}} options
 *   `key` is the `settings.localLlm.<key>` slice this daemon owns
 *   ('mtplx' | 'slotstream'). `launch` REPLACES the whole `launch`
 *   sub-object — callers supply every field they want kept, the same
 *   "replace, don't merge" contract the daemon's own launch line already
 *   has, so a field left out of one start does not linger from the last one.
 */
export async function persistDaemonLaunchConfig({ key, label, launch }) {
  const settings = await import('./settings.js').catch(() => null);
  if (!settings?.updateSettingsWith) return;
  await settings.updateSettingsWith((current) => ({
    ...current,
    localLlm: {
      ...current?.localLlm,
      [key]: {
        ...current?.localLlm?.[key],
        launch,
      },
    },
  })).catch((error) => {
    console.error(`❌ ${label}: could not persist the launch line (${error?.message || 'unknown'}); an idle restart will fall back to defaults`);
  });
}
