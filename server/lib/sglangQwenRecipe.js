/**
 * The SGLang Qwen3.8-27B launch line PortOS owns, per NVIDIA card class.
 *
 * Unlike the RTX 3090 vLLM path — where the compose project is upstream's and
 * PortOS never sees the flags (`lib/vllmQwenProject.js`) — SGLang ships as an
 * official image (`lmsysorg/sglang:qwen38-27b`) with no compose project of its
 * own. The launch line is therefore ours, and this module is it: a pure table of
 * the cookbook's verified cells plus the one derived number the cookbook says
 * actually matters.
 *
 * **Three flags are load-bearing and silent when wrong.**
 *
 *   - `--tool-call-parser` — SGLang spells it differently from vLLM for the very
 *     same model. Get it wrong (or omit it) and the server starts, answers, and
 *     returns raw markup with no `tool_calls` block: the agent narrates edits it
 *     never makes. This is the exact failure the 3090 bring-up hit, and the
 *     reason both parsers are baked into every cell below rather than left to an
 *     `EXTRA_ARGS` line an operator can forget.
 *   - `--reasoning-parser` — same class of failure for the thinking block.
 *
 *     Both come from `lib/qwenAgentParsers.js` via `parserFlagsFor('sglang')`,
 *     and neither spelling is typed here: that table is the one place they live,
 *     precisely so a third runtime cannot copy whichever doc it read first. A
 *     guard test there fails any file that retypes one.
 *   - `--mamba-full-memory-ratio` — see `mambaFullMemoryRatio` below. The
 *     cookbook default (`0.9`) under-sizes the GDN state pool for CoS-length
 *     prompts and silently clamps `max_running_requests` below the concurrency
 *     you asked for. It is derived here, not defaulted.
 *
 * **What is verified and what is derived.** The `h200` cell is transcribed
 * flag-for-flag from the cookbook cell recorded in
 * `docs/research/2026-08-21-sglang-qwen38-27b.md` (`hw=h200, variant=default,
 * quant=fp8, nodes=single, spec=none, tier=low-latency, ssmDtype=float32`), and
 * `sglangQwenRecipe.test.js` pins it so changing a verified flag fails. The two
 * Blackwell cells carry only what that same note records about them (NVFP4
 * quantization; `--max-running-requests 1` on a 32 GB 5090) and deliberately
 * OMIT H200's 32k prefill overrides rather than inventing a number for a cell
 * nobody has measured here — SGLang's own defaults are the honest answer, and
 * `verified: false` says so on the record. Operator bring-up on real Blackwell
 * hardware is expected to refine them (see `docs/features/sglang-qwen38.md`).
 *
 * Speculative overlays (EAGLE/MTP, DSPARK, DFLASH2) are deliberately absent from
 * every default. DFLASH2 in particular needs an SGLang newer than the pinned
 * image; `SPEC_VERIFY_SLOTS` exists so the ratio arithmetic stays correct if a
 * later change adds one, not because one is offered today.
 *
 * Pure: no filesystem, no docker, no network. `lib/sglangQwenProject.js` owns
 * "is this host prepared", and `services/localRuntimeSetup.js` owns starting it.
 */

import { PORTS } from './ports.js';
import { parserFlagsFor } from './qwenAgentParsers.js';

/** The official image. PortOS never builds an engine — same bar as the vLLM path. */
export const SGLANG_QWEN_IMAGE = 'lmsysorg/sglang:qwen38-27b';

/** The model id PortOS declares to OpenCode, independent of the quantized repo. */
export const SGLANG_QWEN_MODEL_ALIAS = 'qwen3.8-27b';

/**
 * Bytes of GDN state per slot, by SSM dtype, in MB — this checkpoint's geometry
 * (64 layers: 48 Gated DeltaNet + 16 full-attention GQA).
 */
const SSM_STATE_MB = Object.freeze({ float32: 153.9, bfloat16: 78.4 });

/** Paged-attention KV bytes per token, by KV cache dtype, in KB. */
const KV_KB_PER_TOKEN = Object.freeze({ fp8_e4m3: 32.8, bfloat16: 65.5 });

/**
 * `S` in the ratio formula — GDN state slots held per running request, by radix
 * cache strategy. `extra_buffer` is the low-latency strategy CoS wants: TTFT on
 * a warm prefix is the number a TUI tool-loop lives on, and the 3090 bring-up
 * measured a 24x collapse when the prefix cache actually hits.
 */
const RADIX_STATE_SLOTS = Object.freeze({
  extra_buffer: 5,
  extra_buffer_lazy: 4,
  off: 1,
});

/** `D` — speculative verify intermediates. Zero with speculation off. */
const SPEC_VERIFY_SLOTS = Object.freeze({
  none: 0,
  eagle: 4,
  dspark: 8,
  dflash2: 8,
});

/**
 * The average total request length (input + output) PortOS sizes the GDN state
 * pool for. The 3090 bring-up's measured 17k-token agent prefix is the data
 * point; 20k rounds it up to leave room for the reply without over-reserving.
 */
export const COS_CONTEXT_LENGTH = 20_000;

/**
 * `--mamba-full-memory-ratio`: GDN state-pool memory as a ratio of paged KV-cache
 * memory, from the cookbook formula
 *
 *     ratio = (S + D) x state_bytes / (L x kv_bytes_per_token)
 *
 * It is a RATIO between two pools, not a fraction of one — values above 1 are
 * normal and expected at CoS prompt lengths, where the per-request state pool
 * legitimately outweighs the KV a single 20k-token request needs.
 *
 * Concurrency deliberately does not appear: both sides of the fraction scale
 * with it, so it cancels. Concurrency is pinned separately via
 * `--max-mamba-cache-size` (`concurrency x S`), which is why `stateSlots` is
 * returned alongside — a caller sizing that flag needs `S`, not a second copy of
 * this table.
 *
 * @param {{contextLength?:number, ssmDtype?:string, kvCacheDtype?:string,
 *          radixStrategy?:string, spec?:string}} [opts]
 * @returns {{ratio:number, stateSlots:number, verifySlots:number}}
 */
export function mambaFullMemoryRatio({
  contextLength = COS_CONTEXT_LENGTH,
  ssmDtype = 'float32',
  kvCacheDtype = 'fp8_e4m3',
  radixStrategy = 'extra_buffer',
  spec = 'none',
} = {}) {
  const stateMb = SSM_STATE_MB[ssmDtype];
  const kvKb = KV_KB_PER_TOKEN[kvCacheDtype];
  const stateSlots = RADIX_STATE_SLOTS[radixStrategy];
  const verifySlots = SPEC_VERIFY_SLOTS[spec];
  if (stateMb === undefined) throw new Error(`Unknown SSM dtype '${ssmDtype}'`);
  if (kvKb === undefined) throw new Error(`Unknown KV cache dtype '${kvCacheDtype}'`);
  if (stateSlots === undefined) throw new Error(`Unknown mamba radix strategy '${radixStrategy}'`);
  if (verifySlots === undefined) throw new Error(`Unknown speculative algorithm '${spec}'`);
  if (!Number.isFinite(contextLength) || contextLength <= 0) {
    throw new Error(`Context length must be a positive number, got '${contextLength}'`);
  }

  // One unit (KB) on both sides, so the MB->KB conversion is stated once.
  const stateKb = (stateSlots + verifySlots) * stateMb * 1024;
  const kvTotalKb = contextLength * kvKb;
  // Three decimals: the flag is a memory-sizing hint, and pinning more digits
  // would make the test assert floating-point noise rather than the recipe.
  return { ratio: Math.round((stateKb / kvTotalKb) * 1000) / 1000, stateSlots, verifySlots };
}

/**
 * One row per NVIDIA card class the cookbook publishes a single-GPU cell for.
 *
 * `chunkedPrefillSize` / `maxPrefillTokens` are `null` on the unverified cells —
 * absent, not zero — so `buildSglangQwenRecipe` omits the flags and SGLang picks
 * its own default. Handing a 32 GB 5090 the H200 cell's 32k prefill chunks is
 * the specific mistake this table exists to prevent.
 */
const HARDWARE_CELLS = Object.freeze({
  h200: Object.freeze({
    id: 'h200',
    label: 'NVIDIA H200 / H100 (SM90 Hopper)',
    verified: true,
    quant: 'fp8',
    modelPath: 'Qwen/Qwen3.8-27B-FP8',
    kvCacheDtype: 'fp8_e4m3',
    memFractionStatic: 0.85,
    attentionBackend: 'flashinfer',
    chunkedPrefillSize: 32768,
    maxPrefillTokens: 32768,
    maxRunningRequests: null,
  }),
  rtx6000: Object.freeze({
    id: 'rtx6000',
    label: 'NVIDIA RTX PRO 6000 Blackwell (96 GB)',
    verified: false,
    // Blackwell has FP4 tensor cores; the cookbook's Blackwell cells use NVFP4.
    quant: 'nvfp4',
    modelPath: 'Qwen/Qwen3.8-27B-NVFP4',
    kvCacheDtype: 'fp8_e4m3',
    memFractionStatic: 0.85,
    attentionBackend: 'flashinfer',
    chunkedPrefillSize: null,
    maxPrefillTokens: null,
    maxRunningRequests: null,
  }),
  rtx5090: Object.freeze({
    id: 'rtx5090',
    label: 'NVIDIA RTX 5090 Blackwell (32 GB)',
    verified: false,
    quant: 'nvfp4',
    modelPath: 'Qwen/Qwen3.8-27B-NVFP4',
    kvCacheDtype: 'fp8_e4m3',
    memFractionStatic: 0.85,
    attentionBackend: 'flashinfer',
    chunkedPrefillSize: null,
    maxPrefillTokens: null,
    // 32 GB leaves the GDN state pool as the binding constraint, so the
    // cookbook's 5090 cell serializes requests rather than clamping them later.
    maxRunningRequests: 1,
  }),
});

/** Card classes with a cell here, most capable first. */
export const SGLANG_HARDWARE_IDS = Object.freeze(Object.keys(HARDWARE_CELLS));

/** One hardware cell, or `null` for an id with no recipe. */
export const sglangHardwareCell = (hw) => HARDWARE_CELLS[hw] ?? null;

/**
 * Which cell (if any) a detected GPU should run, from `cudaCapability.js`'s
 * `parseNvidiaSmiComputeCaps` shape.
 *
 * Compute capability is the primary signal because it is the one column that
 * distinguishes the arches PortOS cares about: SM 8.x is Ampere (which stays on
 * the vLLM container — the cookbook has no 3090 cell), 9.x is Hopper, 10.x/12.x
 * is Blackwell. VRAM only splits the two Blackwell cells apart.
 *
 * Returns `null` for every card without a cell — including Ampere, which is a
 * REFUSAL rather than a gap: `sglangUnsupportedReason` names the vLLM path.
 *
 * @param {{computeCap?:string|null, vramGb?:number|null}|null|undefined} gpu
 * @returns {string|null} a key of `HARDWARE_CELLS`
 */
export function sglangCellForGpu(gpu) {
  const major = Number.parseInt(String(gpu?.computeCap ?? '').split('.')[0], 10);
  if (!Number.isFinite(major)) return null;
  if (major === 9) return 'h200';
  // Blackwell consumer (12.x) and datacenter (10.x) both take the NVFP4 cells;
  // the 96 GB card is the only one with headroom for concurrent requests.
  if (major >= 10) return Number.isFinite(gpu?.vramGb) && gpu.vramGb >= 48 ? 'rtx6000' : 'rtx5090';
  return null;
}

/**
 * Why this host cannot run the SGLang stack, or `null` when it can. Prose the
 * readiness checklist renders verbatim, so each case names where the operator
 * should go instead.
 *
 * The `'unknown'` probe status is NOT collapsed into "no GPU": a wedged or
 * ancient `nvidia-smi` says nothing about the hardware, and telling an H200
 * owner they have no NVIDIA card would send them to the wrong fix entirely.
 *
 * @param {{platform?:string, status?:string, gpus?:Array<object>}} [host]
 * @returns {string|null}
 */
export function sglangUnsupportedReason({ platform = process.platform, status, gpus = [] } = {}) {
  if (platform === 'darwin') {
    return 'The SGLang Qwen3.8-27B stack needs an NVIDIA Hopper or Blackwell GPU and a Linux container runtime. On Apple Silicon use the MTPLX or llama.cpp DSpark presets instead.';
  }
  if (status === 'absent') {
    return 'No NVIDIA GPU was detected on this host, so there is no card to give the SGLang container.';
  }
  if (status === 'unknown') {
    return 'PortOS could not read this host\'s NVIDIA GPUs (`nvidia-smi` is installed but would not answer), so it cannot tell whether the SGLang recipe fits this card. Fix the driver — or start the container yourself following docs/features/sglang-qwen38.md — rather than reading this as "no GPU".';
  }
  if (status === 'available' && !(Array.isArray(gpus) ? gpus : []).some((gpu) => sglangCellForGpu(gpu))) {
    return 'The SGLang Qwen3.8-27B cookbook publishes no recipe for this card. Ampere 24 GB (RTX 3090) is served by the vLLM container instead — see docs/features/qwen38-rtx3090.md.';
  }
  return null;
}

/** Push `--flag value` only when the value is set. Keeps the cell table's nulls honest. */
const flagIf = (flag, value) => (value === null || value === undefined ? [] : [flag, String(value)]);

/**
 * The full `sglang serve` argv for one card class.
 *
 * `host` defaults to loopback, NOT the cookbook's `0.0.0.0`: PortOS binds local
 * daemons to `127.0.0.1` and lets the peer/auth layer decide what leaves the
 * machine (`docs/PORTS.md`).
 *
 * @param {{hw?:string, contextLength?:number, ssmDtype?:string, spec?:string,
 *          radixStrategy?:string, host?:string, port?:number}} [opts]
 * @returns {{image:string, modelName:string, modelPath:string, cell:object,
 *            mambaRatio:number, stateSlots:number, flags:string[], env:object}}
 */
export function buildSglangQwenRecipe({
  hw = 'h200',
  contextLength = COS_CONTEXT_LENGTH,
  ssmDtype = 'float32',
  spec = 'none',
  radixStrategy = 'extra_buffer',
  host = '127.0.0.1',
  port,
} = {}) {
  const cell = sglangHardwareCell(hw);
  if (!cell) throw new Error(`No SGLang recipe for hardware '${hw}'`);
  const { ratio, stateSlots } = mambaFullMemoryRatio({
    contextLength, ssmDtype, kvCacheDtype: cell.kvCacheDtype, radixStrategy, spec,
  });

  return {
    image: SGLANG_QWEN_IMAGE,
    modelName: SGLANG_QWEN_MODEL_ALIAS,
    modelPath: cell.modelPath,
    cell,
    mambaRatio: ratio,
    stateSlots,
    flags: [
      // The checkpoint is served through the Qwen3-VL path, which needs its
      // repo-side modeling code.
      '--trust-remote-code',
      '--model-path', cell.modelPath,
      '--kv-cache-dtype', cell.kvCacheDtype,
      '--mem-fraction-static', String(cell.memFractionStatic),
      '--attention-backend', cell.attentionBackend,
      ...flagIf('--chunked-prefill-size', cell.chunkedPrefillSize),
      ...flagIf('--max-prefill-tokens', cell.maxPrefillTokens),
      ...flagIf('--max-running-requests', cell.maxRunningRequests),
      // Both parsers, always — read from the shared table rather than typed
      // here. See the file header for the silent failure this prevents.
      ...parserFlagsFor('sglang'),
      '--mamba-radix-cache-strategy', radixStrategy,
      '--mamba-ssm-dtype', ssmDtype,
      '--mamba-full-memory-ratio', String(ratio),
      '--host', host,
      '--port', String(port ?? PORTS.SGLANG_QWEN),
    ],
    // Left to the operator's `.env`: HF_TOKEN for a gated repo, and SGLANG_API_KEY
    // only if they chose to run `--api-key`. PortOS ships no secret here.
    env: {},
  };
}

/** Indent a block of YAML list items under a key. */
const yamlList = (items, indent) => items.map((item) => `${indent}- ${item}`).join('\n');

/**
 * The `docker-compose.yml` for one recipe, generated rather than shipped as a
 * static asset so the launch line has exactly one source of truth. Mirrors the
 * cookbook's docker stanza (`ipc: host`, a 32 GB shm, all GPUs, an HF cache
 * volume) minus host networking — the port is published on loopback instead.
 *
 * The published port is read back out of the recipe's own `--port` flag rather
 * than taken as an argument, so the host mapping and the server's bind address
 * cannot drift into disagreeing about which port the container answers on.
 *
 * `docs/features/sglang-qwen38.md` embeds this verbatim for the H200 cell, and
 * `sglangQwenRecipe.test.js` fails if the doc and this function drift.
 *
 * @param {ReturnType<typeof buildSglangQwenRecipe>} recipe
 * @returns {string}
 */
export function sglangComposeYaml(recipe) {
  const portIndex = recipe.flags?.indexOf('--port') ?? -1;
  const port = portIndex === -1 ? null : recipe.flags[portIndex + 1];
  // Loud rather than silent: without this a hand-built recipe missing `--port`
  // would render `127.0.0.1:undefined:undefined` into a compose file that fails
  // much later, with nothing pointing back at the recipe that produced it.
  if (!port) throw new Error('Recipe has no --port flag, so its published port cannot be derived');
  const flags = recipe.flags.map((flag) => JSON.stringify(flag));
  return [
    'services:',
    '  sglang-qwen38:',
    `    image: ${recipe.image}`,
    '    container_name: sglang-qwen38',
    '    restart: "no"',
    '    ipc: host',
    '    shm_size: "32g"',
    '    ports:',
    `      - "127.0.0.1:${port}:${port}"`,
    '    volumes:',
    '      - ${HF_HOME:-./hf-cache}:/root/.cache/huggingface',
    '    environment:',
    '      - HF_TOKEN=${HF_TOKEN:-}',
    '    deploy:',
    '      resources:',
    '        reservations:',
    '          devices:',
    '            - driver: nvidia',
    '              count: all',
    '              capabilities: ["gpu"]',
    // Split entrypoint/command rather than one argv: whether the image already
    // sets an entrypoint is not something PortOS should have to guess at, and
    // naming `sglang` explicitly makes the launch line work either way.
    '    entrypoint: ["sglang"]',
    '    command:',
    '      - "serve"',
    yamlList(flags, '      '),
    '',
  ].join('\n');
}
