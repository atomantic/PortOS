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
 *  - `run({ imagePath, outputPath, onProgress, env, caps, steps, seed })` —
 *    renders; returns `{ promise, kill }`, `promise` resolving `{ assetPath }`.
 *    `caps` is the host-capability snapshot resolved at the request boundary;
 *    `steps`/`seed` are the per-run sampler knobs (null = target default). A
 *    target may ignore any option key it doesn't understand.
 *  - `describeInstallState?()` — optional extra per-target diagnostics: async,
 *    returns `{ warnings?: string[], fields?: object }`. `warnings` are generic
 *    user-facing strings the route can surface (e.g. on an "already installed"
 *    short-circuit) without knowing what they're about — replayed into a `verify`
 *    stage that renders ONE prose string per frame, so anything a warning needs to
 *    say has to fit in the sentence; `fields` are extra keys merged onto the target
 *    in `GET /targets` (e.g. TRELLIS.2's texture-bake quality). Omit when a target
 *    has nothing extra to report.
 *
 *    **A degraded-but-working install reports `fields.degraded`**:
 *    `{ label, help, repairable, detail? }`. This is the ONE shape the client renders,
 *    so the badge / help panel / Repair button work for any target without a per-target
 *    branch. `repairable: false` means re-running install cannot fix it and no Repair
 *    button is offered. `detail` is an optional short line naming the *specific* thing
 *    that is missing (`Missing: o_voxel`) — `help` says which remedy to run, `detail`
 *    says what is actually broken, so a user whose Repair keeps failing has something
 *    to act on instead of the same generic sentence.
 *
 *    Keep specific missing module names in `detail`. `help` describes the
 *    effect and the remedy when one is available. Use `describeDegradedInstall`
 *    to omit an empty detail line and format the matching warning for the stream.
 *
 *    A target may also return its own narrow diagnostic field, but keep it small and
 *    keep the UI off it. `trellis2` still returns `textureBake` with **no in-repo
 *    reader** — retained purely for API back-compat, since an older client on a newer
 *    server reads that field and PortOS installs update independently.
 */

import { hfChildEnv } from '../hfToken.js';
import {
  isTrellis2Installed,
  runTrellis2Generate,
  probeTrellis2TextureBake,
  probeMetalToolchain,
} from './trellis2.js';
import { installTrellis2 } from './trellis2Install.js';
import {
  isTrellis2CudaInstalled,
  installTrellis2Cuda,
  runTrellis2CudaGenerate,
} from './trellis2Cuda.js';
import {
  isPixal3dCudaInstalled,
  runPixal3dCudaGenerate,
  probePixal3dModules,
  PIXAL3D_INCOMPLETE_INSTALL_HELP,
} from './pixal3dCuda.js';
import {
  isPixal3dMpsInstalled,
  installPixal3dMps,
  runPixal3dMpsGenerate,
  describePixal3dMpsInstallState,
  probeMetalToolchain as probePixal3dMpsToolchain,
} from './pixal3dMps.js';
import { describeDegradedInstall } from './degradedInstall.js';

export const TARGET_ADAPTERS = Object.freeze({
  trellis2: Object.freeze({
    isInstalled: isTrellis2Installed,
    install: installTrellis2,
    resolveEnv: hfChildEnv,
    run: runTrellis2Generate,
    async describeInstallState() {
      const bake = await probeTrellis2TextureBake();
      if (bake.quality !== 'fallback') return { fields: { textureBake: bake } };
      const toolchain = await probeMetalToolchain();
      const repairable = toolchain.blocker !== 'requires-xcode';
      const help = repairable ? bake.help : `${bake.help} ${toolchain.hint}`;
      const textureBake = { ...bake, help, repairable };
      const { degraded, warnings } = describeDegradedInstall({
        label: 'degraded textures',
        help,
        repairable,
        missing: bake.missing,
      });
      return { fields: { textureBake, degraded }, warnings };
    },
  }),
  pixal3dMps: Object.freeze({
    isInstalled: isPixal3dMpsInstalled,
    // The Apple port downloads public Hugging Face artifacts, but a configured token
    // avoids anonymous rate limits during its first explicit render.
    resolveEnv: hfChildEnv,
    async install({ onEvent = () => {}, env } = {}) {
      // The native setup requires a working `xcrun metal` toolchain.
      // Reuse the existing toolchain preflight so a full-Xcode host can fetch the
      // optional component before the native packages compile, while a Command-Line-
      // Tools-only host receives the same actionable Xcode guidance as TRELLIS.2.
      const toolchain = await probePixal3dMpsToolchain();
      if (toolchain.blocker) onEvent({ type: 'log', stage: 'preflight', message: `⚠️ ${toolchain.hint}` });
      const installMetalToolchain = toolchain.available === false && toolchain.installable === true;
      if (installMetalToolchain) onEvent({ type: 'log', stage: 'preflight', message: `ℹ️ ${toolchain.hint}` });
      return installPixal3dMps({ onEvent, env, installMetalToolchain });
    },
    run: runPixal3dMpsGenerate,
    describeInstallState: describePixal3dMpsInstallState,
  }),
  trellis2Cuda: Object.freeze({
    isInstalled: isTrellis2CudaInstalled,
    install: installTrellis2Cuda,
    // Upstream's 4B pipeline conditions on the gated DINOv3 repo, so this lane needs
    // the resolved Hugging Face token at render time.
    resolveEnv: hfChildEnv,
    // The export budget (atlas size + decimation target) scales with the card. `run`
    // must stay synchronous to keep its { promise, kill } contract, so it cannot
    // probe — it reads the VRAM out of the capabilities the dispatcher resolved at
    // the request boundary and passed down. An absent/unsized card yields `null`, and
    // the runner picks the conservative 24 GB-floor lane: degraded quality, never an
    // overcommitted GPU.
    run: ({ caps, ...opts }) => runTrellis2CudaGenerate({
      ...opts,
      vramGb: caps?.cudaVramGb ?? null,
    }),
  }),
  pixal3dCuda: Object.freeze({
    isInstalled: isPixal3dCudaInstalled,
    // Nothing Pixal3D pulls is GATED (see its descriptor), but the download still goes
    // through Hugging Face, so the same resolved token is passed for rate-limit
    // headroom on a ~24 GB weight fetch.
    resolveEnv: hfChildEnv,
    // Resolution/offload tier scales with the card. `run` must stay synchronous to keep
    // its { promise, kill } contract, so it reads VRAM out of the capabilities the
    // dispatcher resolved at the request boundary. An absent/unsized card yields `null`
    // and the runner picks the 1024 low-VRAM floor: degraded quality, never an
    // overcommitted GPU.
    run: ({ caps, ...opts }) => runPixal3dCudaGenerate({
      ...opts,
      vramGb: caps?.cudaVramGb ?? null,
    }),
    async describeInstallState() {
      const probe = await probePixal3dModules();
      // A missing required module takes precedence over the optional NAF fallback.
      const incomplete = probe.missing?.length ? probe.missing : null;
      const nafFallback = probe.naf === 'unavailable';
      const projection = incomplete
        ? describeDegradedInstall({
          label: 'incomplete install',
          help: PIXAL3D_INCOMPLETE_INSTALL_HELP,
          repairable: false,
          missing: incomplete,
        })
        : nafFallback
          ? describeDegradedInstall({ label: 'NAF fallback', help: probe.help, repairable: false })
          : null;
      return {
        fields: {
          // Narrow on purpose: shipping the whole probe made the wire shape
          // `target.modules.modules` (a raw find_spec map) with no consumer.
          naf: probe.naf,
          // The normalized shape the client renders — see the adapter contract above.
          ...(projection ? { degraded: projection.degraded } : {}),
        },
        // Replayed into the install route's `verify` stage on the already-installed
        // short-circuit, which renders one prose string and has no second line for
        // `detail` — so the module names ride along in the sentence there.
        warnings: projection?.warnings ?? [],
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
