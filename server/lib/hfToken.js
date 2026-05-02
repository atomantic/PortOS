// HuggingFace token resolution. Stored token (settings.imageGen.hfToken) wins
// over env vars so the user can update from the UI without restarting PortOS.
// huggingface_hub reads HF_TOKEN / HUGGINGFACE_HUB_TOKEN /
// HUGGINGFACEHUB_API_TOKEN — surface all three when injecting into spawn env.

import { getSettings } from '../services/settings.js';

export async function getHfToken() {
  const settings = await getSettings();
  const stored = settings?.imageGen?.hfToken?.trim?.();
  if (stored) return stored;
  return (
    process.env.HF_TOKEN ||
    process.env.HUGGINGFACE_HUB_TOKEN ||
    process.env.HUGGINGFACEHUB_API_TOKEN ||
    null
  );
}

// Spread into a child_process spawn `env` to give the Python child whichever
// token variable name its code reads.
export async function hfTokenEnv() {
  const token = await getHfToken();
  if (!token) return {};
  return {
    HF_TOKEN: token,
    HUGGINGFACE_HUB_TOKEN: token,
    HUGGINGFACEHUB_API_TOKEN: token,
  };
}

// HF tokens are `hf_` + ~36 alphanumeric chars. Exported as a Zod-friendly
// regex so route schemas validate at the boundary instead of post-parse.
export const HF_TOKEN_REGEX = /^hf_[A-Za-z0-9_-]+$/;
