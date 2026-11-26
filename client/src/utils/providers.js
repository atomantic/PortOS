/**
 * Compatibility facade for AI-provider helpers and shared runtime badge metadata.
 *
 * Compatibility facade re-exporting every helper from the nine modules below, so existing
 * `../utils/providers` imports keep working. New code imports the declaring module.
 *
 * The helpers used to live here as one 2,200-line module. They now live in
 * nine responsibility-scoped siblings, each named for the question it answers
 * (and, where one exists, for the server module it mirrors):
 *
 *   providerTypes.js          — what KIND of provider a record is
 *   providerGateways.js       — the hosted-gateway registry a wrapper fronts
 *   providerEndpoints.js      — WHERE its endpoint points (local / fleet / public)
 *   providerModels.js         — which MODEL and EFFORT a run resolves to
 *   providerSelection.js      — which providers/models a picker may OFFER
 *   localModelHeuristics.js   — what an untyped local model can DO
 *   providerContextWindows.js — how large a CONTEXT WINDOW it gets
 *   providerModelAccess.js    — which of its catalog this install is ENTITLED to
 *   providerReadiness.js      — is it READY to run, and why not
 *   providerAssignments.js    — which provider a RECORD resolves to; assignment options
 *
 * Every existing `import { … } from '../utils/providers'` keeps working through
 * this file. New code should import the declaring module — that is where a
 * change belongs, and where each shared table is re-exported from its
 * `server/lib` leaf rather than copied.
 */

import { localRuntimeKind } from '../../../server/lib/modelPinMembership.js';

export * from './localModelHeuristics.js';
export * from './providerAssignments.js';
export * from './providerContextWindows.js';
export * from './providerModelAccess.js';
export * from './providerEndpoints.js';
export * from './providerGateways.js';
export * from './providerModels.js';
export * from './providerReadiness.js';
export * from './providerSelection.js';
export * from './providerTypes.js';

const GPU_MEMORY_NOTE = 'It holds the whole GPU, so stop it before running local image/video generation.';

export const RUNTIME_BADGE_META = {
  llama: {
    label: 'LLAMA.CPP / DFLASH',
    badgeClass: 'bg-purple-500/20 text-purple-300 border border-purple-500/30',
    descriptionClass: 'text-purple-300/90',
    endpointClass: 'text-purple-200',
    description: 'Local llama.cpp / llama-server harness',
    detail: 'Supports DFlash 2 speculative drafting.',
  },
  vllm: {
    label: 'vLLM / DFLASH2',
    badgeClass: 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30',
    descriptionClass: 'text-emerald-300/90',
    endpointClass: 'text-emerald-200',
    description: 'Local vLLM container',
    detail: `Qwen3.8-27B with DFlash 2 drafting. ${GPU_MEMORY_NOTE}`,
    fleet: {
      description: 'Fleet vLLM runtime',
      detail: 'Qwen3.8-27B with DFlash 2 drafting. This PortOS sends work over the private network; runtime lifecycle stays on the GPU host.',
    },
  },
  sglang: {
    label: 'SGLANG',
    badgeClass: 'bg-amber-500/20 text-amber-300 border border-amber-500/30',
    descriptionClass: 'text-amber-300/90',
    endpointClass: 'text-amber-200',
    description: 'Local SGLang container',
    detail: `Qwen3.8-27B on a Hopper or Blackwell card. ${GPU_MEMORY_NOTE}`,
  },
  mtplx: {
    label: 'MTPLX',
    badgeClass: 'bg-blue-500/20 text-blue-300 border border-blue-500/30',
    description: 'MTPLX runtime with native multi-token prediction on Apple Silicon.',
  },
  slotstream: {
    label: 'SLOTSTREAM',
    badgeClass: 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30',
    description: 'Slotstream runtime for SSD-streamed mixture-of-experts models on Apple Silicon.',
  },
  splash: {
    label: 'SPLASH',
    badgeClass: 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30',
    description: 'Splash runtime for Inkling 2 Mini.',
  },
  mkserve: {
    label: 'MKSERVE',
    badgeClass: 'bg-sky-500/20 text-sky-300 border border-sky-500/30',
    description: 'mkserve runtime for Inkling 2 Mini.',
  },
};

export const runtimeBadgeMeta = (provider) => RUNTIME_BADGE_META[localRuntimeKind(provider)];
