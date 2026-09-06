/**
 * Ship a disabled Slotstream provider preset to existing installs.
 *
 * Slotstream is a separately managed local runtime (SSD-streaming MoE) —
 * see docs/features/slotstream.md. It answers ordinary text tasks through its
 * loopback OpenAI-compatible endpoint the same way MTPLX's API preset does
 * (migration 272): text-only, so no CLI/TUI variant is registered — Slotstream
 * is not a valid CoS coding-agent runner.
 *
 * This migration deliberately does not install Slotstream, download a
 * checkpoint, start a daemon, or contact its endpoint. The preset is disabled
 * by default. An install that already owns this id is left untouched,
 * preserving refreshed models and local endpoint edits.
 *
 * Kept in lockstep with data.reference/providers.json and
 * server/lib/aiToolkit/defaults/providers.sample.json. This frozen literal is
 * the historical upgrade payload; later default changes require a new
 * migration rather than rewriting this record.
 */

import { makeProviderSeedMigration } from './_lib.js';

const SLOTSTREAM_API = {
  id: 'slotstream',
  name: 'Slotstream (SSD-streaming MoE)',
  type: 'api',
  endpoint: 'http://127.0.0.1:5564/v1',
  apiKey: '',
  models: ['qwen3-235b-a22b-4bit', 'gpt-oss-120b-mxfp4', 'qwen3-30b-a3b-4bit'],
  defaultModel: 'qwen3-235b-a22b-4bit',
  timeout: 300000,
  enabled: false,
  envVars: {},
};

export default makeProviderSeedMigration({
  label: 'Slotstream',
  defs: [SLOTSTREAM_API],
});
