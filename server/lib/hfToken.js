// HuggingFace token resolution. Stored token (settings.imageGen.hfToken) wins
// over env vars so the user can update from the UI without restarting PortOS.
// huggingface_hub reads HF_TOKEN / HUGGINGFACE_HUB_TOKEN /
// HUGGINGFACEHUB_API_TOKEN — surface all three when injecting into spawn env.
// Final fallback reads ~/.cache/huggingface/token (written by `hf auth login`)
// so the FLUX.2 banner doesn't nag users who already authenticated via the CLI.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { tryReadFile } from './fileUtils.js';
import { getSettings } from '../services/settings.js';

const HF_CLI_TOKEN_PATH = join(homedir(), '.cache', 'huggingface', 'token');

async function readHfCliToken() {
  const buf = await tryReadFile(HF_CLI_TOKEN_PATH);
  const trimmed = buf?.trim();
  return trimmed || null;
}

export async function getHfToken() {
  const { token } = await getHfTokenInfo();
  return token;
}

// Same lookup as `getHfToken()` but also surfaces *where* the token came from
// so the Settings UI can show "Stored token configured" vs "Using env var
// HF_TOKEN" — and so the Clear button only appears when the stored entry is
// the one being used. `source` is one of: 'stored' | 'env' | 'cli' | 'none'.
export async function getHfTokenInfo() {
  const settings = await getSettings();
  const stored = settings?.imageGen?.hfToken?.trim?.();
  if (stored) return { token: stored, source: 'stored' };
  const envToken = (
    process.env.HF_TOKEN ||
    process.env.HUGGINGFACE_HUB_TOKEN ||
    process.env.HUGGINGFACEHUB_API_TOKEN ||
    null
  );
  if (envToken) return { token: envToken, source: 'env' };
  const cliToken = await readHfCliToken();
  if (cliToken) return { token: cliToken, source: 'cli' };
  return { token: null, source: 'none' };
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
