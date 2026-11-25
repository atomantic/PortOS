/**
 * The one table of PM2-managed local model runtimes (llama.cpp, MTPLX, Slotstream, Splash, mkserve) and the helpers that derive "which PM2 apps are ours" lists from it.
 *
 * A pure leaf with no imports, so `appProcessStatus.js` can read the names without pulling `managedDaemon.js`'s closure. A new runtime is one row here plus its
 * `LOCAL_RUNTIMES` row; `managedRuntimeApps.test.js` fails if the two tables drift. `bootPersist` marks a runtime whose process belongs in the `pm2 save` boot dump;
 * the others start on demand from their controls, so `POST /api/local-llm/save-startup` excludes them. PM2 names never change: a rename would orphan a running process.
 */
export const MANAGED_RUNTIME_APPS = Object.freeze({
  llama: Object.freeze({ app: 'portos-llama-server', bootPersist: true }),
  mtplx: Object.freeze({ app: 'portos-mtplx', bootPersist: false }),
  slotstream: Object.freeze({ app: 'portos-slotstream', bootPersist: false }),
  splash: Object.freeze({ app: 'portos-splash', bootPersist: false }),
  mkserve: Object.freeze({ app: 'portos-mkserve', bootPersist: false }),
});

/** PM2 app name of every managed runtime. */
export const managedRuntimeAppNames = () => Object.values(MANAGED_RUNTIME_APPS).map((row) => row.app);

/** PM2 app names left out of the saved boot list (runtimes that start on demand). */
export const onDemandRuntimeAppNames = () => Object.values(MANAGED_RUNTIME_APPS).filter((row) => !row.bootPersist).map((row) => row.app);
