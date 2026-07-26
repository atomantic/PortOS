/**
 * Image-to-3D — target adapter registry.
 *
 * The single wiring point between a target's pure descriptor (`targets.js`) and
 * its actual install/runner implementation. `targets.js` stays a dependency-light
 * set of descriptors with no imported runners; this module is the impure boundary
 * that resolves a target id to real functions. Availability comes from
 * `targets.js`; installed-state, install dispatch, and render dispatch for every
 * target all resolve through `getTargetAdapter()` here — adding a second target is
 * one registration in this file (plus its descriptor in `targets.js`), not new
 * branches in `routes/imageTo3d.js` or `models.js` (#3080).
 *
 * Adapter contract:
 *  - `isInstalled()` — boolean; is the target's local runtime present? A target
 *    with no local-install concept (a future hosted-API target) would return true.
 *    The caller (the install route) uses this to short-circuit an "already
 *    installed" request before ever calling `install()`.
 *  - `resolveEnv?()` — optional async credential/env resolver, called by the
 *    install route and the render dispatcher before `install()`/`run()`. Each
 *    target declares its own needs here (TRELLIS.2 resolves the stored Hugging
 *    Face token) instead of the dispatch layer assuming every target wants one.
 *    Omit for a target with nothing to resolve — its `env` argument is then
 *    `undefined` and the child process just inherits `process.env`.
 *  - `install({ onEvent, env })` — installs (or repairs, when the caller decides
 *    an already-installed target should re-run setup — see the route). Returns
 *    `{ promise, kill }`. Omit for a target with no install step.
 *  - `run({ imagePath, outputPath, onProgress, env })` — renders; returns
 *    `{ promise, kill }`, `promise` resolving `{ assetPath }`.
 *  - `describeInstallState?()` — optional extra per-target diagnostics: async,
 *    returns `{ warnings?: string[], fields?: object }`. `warnings` are generic
 *    user-facing strings the route can surface (e.g. on an "already installed"
 *    short-circuit) without knowing what they're about; `fields` are extra keys
 *    merged onto the target in `GET /targets` (e.g. TRELLIS.2's texture-bake
 *    quality). Omit when a target has nothing extra to report.
 */

import { hfChildEnv } from '../../lib/hfToken.js';
import {
  isTrellis2Installed,
  installTrellis2,
  runTrellis2Generate,
  probeTrellis2TextureBake,
  probeMetalToolchain,
} from './trellis2.js';

export const TARGET_ADAPTERS = Object.freeze({
  trellis2: Object.freeze({
    isInstalled: isTrellis2Installed,
    // The pipeline pulls gated HF repos (DINOv3, RMBG-2.0) at load time, so both
    // install and render need the resolved token — settings.imageGen.hfToken
    // first, then the env/CLI fallbacks.
    resolveEnv: hfChildEnv,
    async install({ onEvent = () => {}, env } = {}) {
      // `setup.sh` compiles its texture-baking backends from `.metal` sources but
      // swallows each failure and still exits 0, so a host missing the toolchain
      // would otherwise finish "successfully" and render scrambled surfaces
      // forever (#2952). Resolve it before spawning anything so the fetch can be
      // added as a leading install step (#3041), or at least warned about.
      const toolchain = await probeMetalToolchain();
      if (toolchain.blocker) onEvent({ type: 'log', stage: 'preflight', message: `⚠️ ${toolchain.hint}` });
      const installMetalToolchain = toolchain.available === false && toolchain.installable === true;
      if (installMetalToolchain) onEvent({ type: 'log', stage: 'preflight', message: `ℹ️ ${toolchain.hint}` });
      return installTrellis2({ onEvent, env, installMetalToolchain });
    },
    run: runTrellis2Generate,
    async describeInstallState() {
      const bake = await probeTrellis2TextureBake();
      const toolchain = bake.quality === 'fallback' ? await probeMetalToolchain() : null;
      // A degraded bake has two very different remedies, and the card must not
      // offer the wrong one: when the Metal Toolchain is merely missing, Repair
      // install fetches it and rebuilds (#3041); when only the Command Line Tools
      // are active there is nothing PortOS can run, and the user has to install
      // Xcode first.
      const textureBake = toolchain?.blocker
        ? { ...bake, repairable: false, blocker: toolchain.blocker, help: toolchain.hint }
        : { ...bake, ...(bake.quality === 'fallback' ? { repairable: true } : {}) };
      return {
        fields: { textureBake },
        warnings: textureBake.quality === 'fallback' ? [textureBake.help] : [],
      };
    },
  }),
});

/**
 * Look up a target's adapter by id.
 * @param {string} id
 * @returns {object|null} the frozen adapter, or null when unknown.
 */
export function getTargetAdapter(id) {
  return (id && TARGET_ADAPTERS[id]) || null;
}
