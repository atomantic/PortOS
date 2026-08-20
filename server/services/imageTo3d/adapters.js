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
 *    short-circuit) without knowing what they're about; `fields` are extra keys
 *    merged onto the target in `GET /targets` (e.g. TRELLIS.2's texture-bake
 *    quality). Omit when a target has nothing extra to report.
 *
 *    **A degraded-but-working install reports `fields.degraded`**:
 *    `{ label, help, repairable }`. This is the ONE shape the client renders, so the
 *    badge / help panel / Repair button work for any target without a per-target
 *    branch. `repairable: false` means re-running install cannot fix it and no Repair
 *    button is offered.
 *
 *    A target may also return its own narrow diagnostic field, but keep it small and
 *    keep the UI off it. `trellis2` still returns `textureBake` with **no in-repo
 *    reader** — retained purely for API back-compat, since an older client on a newer
 *    server reads that field and PortOS installs update independently.
 */

import { hfChildEnv } from '../../lib/hfToken.js';
import {
  isTrellis2Installed,
  installTrellis2,
  runTrellis2Generate,
  probeTrellis2TextureBake,
  probeMetalToolchain,
} from './trellis2.js';
import {
  isTrellis2CudaInstalled,
  installTrellis2Cuda,
  runTrellis2CudaGenerate,
} from './trellis2Cuda.js';
import {
  isPixal3dCudaInstalled,
  installPixal3dCuda,
  runPixal3dCudaGenerate,
  probePixal3dModules,
} from './pixal3dCuda.js';
import { detectCudaComputeCapability } from '../../lib/cudaCapability.js';

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
      const degradedBake = bake.quality === 'fallback';
      const toolchain = degradedBake ? await probeMetalToolchain() : null;
      // A degraded bake has two very different remedies, and the card must not
      // offer the wrong one: when the Metal Toolchain is merely missing, Repair
      // install fetches it and rebuilds (#3041); when only the Command Line Tools
      // are active there is nothing PortOS can run, and the user has to install
      // Xcode first.
      const textureBake = toolchain?.blocker
        ? { ...bake, repairable: false, blocker: toolchain.blocker, help: toolchain.hint }
        : { ...bake, ...(degradedBake ? { repairable: true } : {}) };
      return {
        fields: {
          textureBake,
          // Normalized degraded-state projection — see the `degraded` note in this
          // file's adapter contract. The client renders THIS, not `textureBake`, so a
          // target with a different kind of degradation needs no new UI branch.
          ...(degradedBake ? {
            degraded: {
              label: 'degraded textures',
              help: textureBake.help,
              repairable: textureBake.repairable !== false,
            },
          } : {}),
        },
        warnings: degradedBake ? [textureBake.help] : [],
      };
    },
  }),
  trellis2Cuda: Object.freeze({
    isInstalled: isTrellis2CudaInstalled,
    // Upstream's 4B pipeline conditions on the gated DINOv3 repo, so this lane needs
    // the resolved Hugging Face token for both install and render — same as the MPS
    // lane, resolved through the same helper.
    resolveEnv: hfChildEnv,
    install: installTrellis2Cuda,
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
    async install({ onEvent = () => {}, env } = {}) {
      // NATTEN compiles CUDA kernels for a specific arch, so the install needs this
      // host's compute capability. Resolved HERE (the impure adapter boundary) rather
      // than inside the pure step builder, and never guessed: an `unknown` probe omits
      // the env var so NATTEN picks its own default instead of building for the wrong
      // card. Surfaced as a log line because it changes what the build produces.
      const probe = await detectCudaComputeCapability();
      const computeCap = probe.primaryComputeCap;
      onEvent({
        type: 'log',
        stage: 'preflight',
        message: computeCap
          ? `\u2139\uFE0F Building NATTEN for CUDA arch ${computeCap}.`
          : '\u26A0\uFE0F Could not read this GPU\u2019s CUDA compute capability — '
            + 'NATTEN will build for its default arch, which may not match this card.',
      });
      return installPixal3dCuda({ onEvent, env, computeCap });
    },
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
      // A REQUIRED module missing means the install did not COMPLETE — `setup.sh` is
      // sourced and can exit 0 with a failed extension build, and `installPixal3dCuda`'s
      // `verify` hook only checks the interpreter and the entrypoint, never the compiled
      // extensions. So this is the only place that can surface it: without this, a
      // half-built install reads plain "Ready" and the first render dies deep in the GLB
      // exporter as an unclassified failure.
      const incomplete = probe.missing?.length ? probe.missing : null;
      const nafFallback = probe.naf === 'unavailable';
      // An incomplete install outranks a NAF fallback — it is the more severe problem,
      // and the same Repair action addresses both, so only the worse one is reported.
      const degraded = incomplete
        ? {
          label: 'incomplete install',
          help: `Pixal3D is installed but ${incomplete.join(' and ')} did not build, so renders `
            + 'will fail in the mesh exporter. Repair install rebuilds the CUDA extensions; '
            + 'your downloaded models are kept.',
          repairable: true,
        }
        : nafFallback
          ? { label: 'NAF fallback', help: probe.help, repairable: true }
          : null;
      return {
        fields: {
          // Narrow on purpose: shipping the whole probe made the wire shape
          // `target.modules.modules` (a raw find_spec map) with no consumer.
          naf: probe.naf,
          // The normalized shape the client renders — see the adapter contract above.
          ...(degraded ? { degraded } : {}),
        },
        warnings: degraded?.help ? [degraded.help] : [],
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
