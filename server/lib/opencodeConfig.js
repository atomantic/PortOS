/**
 * OpenCode configuration helpers.
 *
 * OpenCode (the CLI) requires a models map in its config for any --model flag
 * to be accepted. The shipped OPENCODE_CONFIG_CONTENT was missing this map,
 * causing every --model to be rejected as "not valid". This module builds the
 * config dynamically at spawn time from the effective model.
 */

import { isOpencodeCommand, prefixOpencodeModel } from './providerModels.js';

/**
 * Base OpenCode config structure for Ollama-backed providers (permission +
 * provider block). The models map is added dynamically per-run.
 */
const OPENCODE_OLLAMA_BASE_CONFIG = {
  permission: 'allow',
  provider: {
    ollama: {
      npm: '@ai-sdk/openai-compatible',
      name: 'Ollama (local)',
      options: { baseURL: 'http://localhost:11434/v1' },
    },
  },
};

/**
 * Build an OpenCode config object with the models map populated from the
 * effective model. Returns the base config (no models) if no model is provided.
 *
 * @param {string|null|undefined} prefixedModel - Model id with ollama/ prefix
 * @returns {object} OpenCode config object
 */
export function buildOpencodeConfig(prefixedModel) {
  if (!prefixedModel) {
    return { ...OPENCODE_OLLAMA_BASE_CONFIG };
  }
  return {
    ...OPENCODE_OLLAMA_BASE_CONFIG,
    models: {
      [prefixedModel]: { name: prefixedModel, tool_call: true },
    },
  };
}

/**
 * Build OPENCODE_CONFIG_CONTENT env var value for an Ollama-backed OpenCode
 * provider. Returns the JSON string ready to set as an env var.
 *
 * @param {string|null|undefined} prefixedModel - Model id with ollama/ prefix
 * @returns {string} JSON string for OPENCODE_CONFIG_CONTENT env var
 */
export function buildOpencodeConfigContent(prefixedModel) {
  return JSON.stringify(buildOpencodeConfig(prefixedModel));
}

/**
 * Build dynamic env vars for an OpenCode Ollama provider spawn. Returns an
 * object with OPENCODE_CONFIG_CONTENT if the provider is Ollama-backed OpenCode,
 * otherwise returns an empty object.
 *
 * @param {{command?:string, ollamaBacked?:boolean}} provider
 * @param {string|null|undefined} model - Raw model id (will be prefixed)
 * @returns {{OPENCODE_CONFIG_CONTENT?: string}} Env vars to merge
 */
export function buildOpencodeEnvVars(provider, model) {
  if (!isOpencodeCommand(provider?.command) || provider?.ollamaBacked !== true) {
    return {};
  }
  const prefixedModel = prefixOpencodeModel(provider, model);
  return {
    OPENCODE_CONFIG_CONTENT: buildOpencodeConfigContent(prefixedModel),
  };
}
