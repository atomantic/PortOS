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
 *    **`help` carries the remedy and NOTHING ELSE** — never the culprit names, even
 *    though it reads fine on its own that way: the card renders both, so interpolating
 *    them into the sentence prints them twice on one target and styles them on the
 *    next (#4741). Build both halves with `describeDegradedInstall` from
 *    `degradedInstall.js` rather than assembling the object here — it applies the
 *    omit-`detail`-when-there-is-nothing-to-name rule (an empty label must never
 *    render) and produces the matching `warnings` sentence in one place.
 *
 *    A target may also return its own narrow diagnostic field, but keep it small and
 *    keep the UI off it. `trellis2` still returns `textureBake` with **no in-repo
 *    reader** — retained purely for API back-compat, since an older client on a newer
 *    server reads that field and PortOS installs update independently.
 */

import { hfChildEnv } from '../hfToken.js';
import {
  isTrellis2Installed,
  installTrellis2,
  runTrellis2Generate,
  probeTrellis2TextureBake,
  probeMetalToolchain,
  resolveDegradedBakeRemedy,
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
      // A degraded bake has two very different remedies, and the card must not offer
      // the wrong one: when the Metal Toolchain is merely missing, Repair install
      // fetches it and rebuilds (#3041); when only the Command Line Tools are active
      // there is nothing PortOS can run, and the user has to install Xcode first. The
      // install's own `verify` frame resolves it through the SAME helper, so the two
      // lanes cannot name different fixes for one host state (#4742).
      const textureBake = { ...bake, ...(resolveDegradedBakeRemedy(bake, toolchain) ?? {}) };
      // Which modules failed to build is kept on the toolchain-`blocker` path too, where
      // `help` becomes the Xcode hint but WHICH modules failed is still the useful half.
      // `degradedQuality` is deliberately NOT passed: `flex_gemm` lowers bake quality
      // without forcing the fallback baker, so naming it would blame it for a confetti
      // surface it did not cause.
      const projection = degradedBake ? describeDegradedInstall({
        label: 'degraded textures',
        help: textureBake.help,
        repairable: textureBake.repairable !== false,
        missing: bake.missing,
      }) : null;
      return {
        fields: {
          textureBake,
          // Normalized degraded-state projection — see the `degraded` note in this
          // file's adapter contract. The client renders THIS, not `textureBake`, so a
          // target with a different kind of degradation needs no new UI branch.
          ...(projection ? { degraded: projection.degraded } : {}),
        },
        // Replayed verbatim into the install route's `verify` stage on the
        // already-installed short-circuit — the SAME stage the install's own verify
        // hook writes.
        warnings: projection?.warnings ?? [],
      };
    },
  }),
  pixal3dMps: Object.freeze({
    isInstalled: isPixal3dMpsInstalled,
    // The Apple port downloads public Hugging Face artifacts, but a configured token
    // avoids anonymous rate limits during its first explicit render.
    resolveEnv: hfChildEnv,
    async install({ onEvent = () => {}, env } = {}) {
      // The fork's setup script refuses to start unless `xcrun metal` is available.
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
      // sourced and can exit 0 with a failed extension build. `installPixal3dCuda`'s
      // `verify` hook now probes the same modules and warns as the install finishes, so
      // this is the standing report of that state rather than the only one: a user who
      // missed the install log must still not see a half-built install read plain
      // "Ready" and then have the first render die deep in the GLB exporter as an
      // unclassified failure.
      const incomplete = probe.missing?.length ? probe.missing : null;
      const nafFallback = probe.naf === 'unavailable';
      // An incomplete install outranks a NAF fallback — it is the more severe problem,
      // and the same Repair action addresses both, so only the worse one is reported.
      const projection = incomplete
        ? describeDegradedInstall({
          label: 'incomplete install',
          help: PIXAL3D_INCOMPLETE_INSTALL_HELP,
          missing: incomplete,
        })
        : nafFallback
          // No module list to name — NATTEN is absent as a whole, not half-built.
          ? describeDegradedInstall({ label: 'NAF fallback', help: probe.help })
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
