/**
 * Vision Test Service
 *
 * Tests LM Studio's vision capabilities by sending images to the API
 * and verifying the model can correctly interpret them.
 */

import { readFile, readdir } from 'fs/promises';
import { extname } from 'path';
import { getProviderById } from './providers.js';
import { PATHS, resolveScreenshot } from '../lib/fileUtils.js';
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js';
import { ensureProviderReady as ensureOllamaProviderReady } from './ollamaManager.js';
import { describeImageViaCli } from './visionCli.js';

const SCREENSHOTS_DIR = PATHS.screenshots;
const DEFAULT_VISION_TIMEOUT_MS = 60000;
const VISION_HEALTH_TIMEOUT_MS = 5000;

/**
 * Get MIME type from file extension
 * @param {string} filepath - Path to the file
 * @returns {string} - MIME type
 */
function getMimeType(filepath) {
  const ext = extname(filepath).toLowerCase();
  const mimeTypes = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp'
  };
  return mimeTypes[ext] || 'image/png';
}

/**
 * Load an image as base64 data URL
 * @param {string} imagePath - Path to the image file
 * @returns {Promise<string>} - Base64 data URL
 */
async function loadImageAsBase64(imagePath) {
  // `imagePath` originates from req.body — basename-allowlist it to a real file
  // under SCREENSHOTS_DIR. This rejects `../` traversal and absolute-path
  // escapes so an attacker can't have an arbitrary file base64-encoded and
  // forwarded to the external vision provider (issue #1820).
  const fullPath = resolveScreenshot(imagePath);
  if (!fullPath) {
    throw new Error(`Image not found under screenshots dir: ${imagePath}`);
  }

  const buffer = await readFile(fullPath);
  const mimeType = getMimeType(fullPath);
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

/**
 * Call LM Studio API with vision request
 * @param {Object} options - Request options
 * @param {string} options.endpoint - API endpoint
 * @param {string} options.apiKey - API key
 * @param {string} options.model - Model to use
 * @param {string} options.imageDataUrl - Base64 image data URL
 * @param {string} options.prompt - Prompt to send with image
 * @param {number} options.timeout - Request timeout in ms
 * @param {number} [options.maxTokens=500] - Completion budget. The default suits
 *   short "describe this" calls; callers that ask the model for a larger
 *   structured response (e.g. a JSON object) must raise it or the reply
 *   truncates mid-output and fails to parse.
 * @returns {Promise<Object>} - API response
 */
async function callVisionAPI({ endpoint, apiKey, model, imageDataUrl, prompt, timeout = DEFAULT_VISION_TIMEOUT_MS, maxTokens = 500 }) {
  await ensureOllamaProviderReady({ endpoint }).then((ready) => {
    if (!ready.success) throw new Error(`Ollama is not running and PortOS could not start it: ${ready.error || 'unknown error'}`);
  });

  const response = await fetchWithTimeout(`${endpoint}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: imageDataUrl
              }
            },
            {
              type: 'text',
              text: prompt
            }
          ]
        }
      ],
      max_tokens: maxTokens,
      temperature: 0.1
    })
  }, timeout);

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(`Vision API error ${response.status}: ${errorText}`);
  }

  return response.json();
}

/**
 * Test vision capability with a specific image and prompt
 * @param {Object} options - Test options
 * @param {string} options.imagePath - Path to test image
 * @param {string} options.prompt - Test prompt
 * @param {string} options.expectedContent - Keywords expected in response
 * @param {string} [options.providerId='lmstudio'] - Provider to use
 * @param {string} [options.model] - Model to use (defaults to provider's default)
 * @returns {Promise<Object>} - Test result
 */
export async function testVision({ imagePath, prompt, expectedContent, providerId = 'lmstudio', model }) {
  const startTime = Date.now();

  // Get provider configuration. The AI toolkit warms at server boot, so an
  // AI_TOOLKIT_NOT_INITIALIZED code only fires from a vision test that races
  // boot — surface the boot state directly rather than masquerading as "not
  // found", which would send the user looking for the wrong root cause.
  let provider;
  try {
    provider = await getProviderById(providerId);
  } catch (err) {
    return {
      success: false,
      error: err.code === 'AI_TOOLKIT_NOT_INITIALIZED'
        ? 'AI provider service is still initializing — try again in a moment'
        : err.message,
      duration: Date.now() - startTime
    };
  }
  if (!provider) {
    return {
      success: false,
      error: `Provider '${providerId}' not found`,
      duration: Date.now() - startTime
    };
  }

  if (provider.type !== 'api') {
    return {
      success: false,
      error: `Provider '${providerId}' is not an API provider (type: ${provider.type})`,
      duration: Date.now() - startTime
    };
  }

  const testModel = model || provider.defaultModel;
  if (!testModel) {
    return {
      success: false,
      error: 'No model specified and provider has no default model',
      duration: Date.now() - startTime
    };
  }

  // Load image
  const imageDataUrl = await loadImageAsBase64(imagePath).catch(err => {
    throw new Error(`Failed to load image: ${err.message}`);
  });

  console.log(`🔍 Testing vision with model: ${testModel} | image: ${imagePath}`);

  // Call vision API
  const apiResponse = await callVisionAPI({
    endpoint: provider.endpoint,
    apiKey: provider.apiKey,
    model: testModel,
    imageDataUrl,
    prompt,
    timeout: provider.timeout || DEFAULT_VISION_TIMEOUT_MS
  });

  const responseContent = apiResponse.choices?.[0]?.message?.content || '';
  const duration = Date.now() - startTime;

  // Check if expected content is present
  const expectedTerms = Array.isArray(expectedContent) ? expectedContent : [expectedContent];
  const foundTerms = expectedTerms.filter(term =>
    responseContent.toLowerCase().includes(term.toLowerCase())
  );
  const allFound = foundTerms.length === expectedTerms.length;

  console.log(`✅ Vision test completed in ${duration}ms`);
  console.log(`📝 Response: ${responseContent.substring(0, 200)}...`);

  return {
    success: allFound,
    model: testModel,
    provider: providerId,
    imagePath,
    prompt,
    response: responseContent,
    expectedTerms,
    foundTerms,
    missingTerms: expectedTerms.filter(t => !foundTerms.includes(t)),
    duration,
    usage: apiResponse.usage || null
  };
}

/**
 * Describe an in-memory image (base64 data URL) using a provider's vision
 * endpoint and return the model's text. Used by the voice agent's
 * ui_describe_visually tool, which captures a screenshot client-side rather
 * than reading one off disk. Throws on provider/transport errors so the caller
 * can surface them.
 * @param {Object} options
 * @param {string} options.dataUrl - base64 image data URL (data:image/...;base64,...)
 * @param {string} options.prompt - What to ask about the image
 * @param {string} [options.providerId='lmstudio'] - Vision-capable API provider
 * @param {string} [options.model] - Model override (defaults to provider default)
 * @param {number} [options.maxTokens] - Completion budget; raise it above the
 *   default when asking the model for a long/structured reply (see callVisionAPI).
 * @returns {Promise<string>} - The model's description text
 */
export async function describeImageDataUrl(opts) {
  return (await describeImageDataUrlDetailed(opts)).text;
}

// Pull any hidden chain-of-thought a reasoning model emitted out of band, so an
// empty `content` can be explained ("it reasoned but produced no caption")
// rather than mislabeled as a refusal. Backends surface this differently:
// Ollama's OpenAI-compat puts it on `message.reasoning`, LM Studio on
// `message.reasoning_content`, and some models leak an inline `<think>…</think>`
// block into `content`. Returns the reasoning text (trimmed) or ''.
function extractReasoning(message) {
  if (!message || typeof message !== 'object') return '';
  const direct = message.reasoning || message.reasoning_content || message.thinking;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const content = typeof message.content === 'string' ? message.content : '';
  const inline = content.match(/<think>([\s\S]*?)<\/think>/i);
  return inline ? inline[1].trim() : '';
}

/**
 * Like {@link describeImageDataUrl} but returns the model's text alongside the
 * diagnostics that explain a blank reply — `finishReason` ('length' = cut off
 * at the token budget), token `usage`, and any out-of-band `reasoning`. The
 * caption loop uses these to tell a real refusal apart from a reasoning model
 * that burned its whole budget thinking and returned no caption.
 * @returns {Promise<{ text: string, finishReason: string|null, usage: object|null, reasoning: string }>}
 */
export async function describeImageDataUrlDetailed({ dataUrl, prompt, providerId = 'lmstudio', model, maxTokens }) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
    throw new Error('dataUrl must be a base64 image data URL');
  }
  const provider = await getProviderById(providerId);
  if (!provider) throw new Error(`Provider '${providerId}' not found`);
  // CLI providers (codex / claude-code with vision) read the image from a file
  // rather than an `image_url` block — delegate to the CLI vision path, which
  // returns the same { text, finishReason, usage, reasoning } shape. maxTokens
  // has no CLI analogue (the CLI manages its own budget) so it's dropped.
  if (provider.type === 'cli') {
    return describeImageViaCli({
      provider, dataUrl, prompt: prompt || 'Describe what you see in this image.', model,
      // Honor the provider's configured timeout (seeded codex/claude CLI
      // providers allow 300s/900s) — a vision caption/crop run can outlast the
      // CLI path's 120s default. Falls back to that default when unset.
      ...(provider.timeout ? { timeout: provider.timeout } : {}),
    });
  }
  if (provider.type !== 'api') throw new Error(`Provider '${providerId}' is not an API provider (type: ${provider.type})`);
  const visionModel = model || provider.defaultModel;
  if (!visionModel) throw new Error('No model specified and provider has no default model');

  const apiResponse = await callVisionAPI({
    endpoint: provider.endpoint,
    apiKey: provider.apiKey,
    model: visionModel,
    imageDataUrl: dataUrl,
    prompt: prompt || 'Describe what you see in this image.',
    timeout: provider.timeout || DEFAULT_VISION_TIMEOUT_MS,
    ...(maxTokens != null ? { maxTokens } : {}),
  });
  const choice = apiResponse.choices?.[0];
  // A reasoning model that leaks its chain-of-thought inline emits
  // `<think>…</think>` followed by the real answer; strip a LEADING think block
  // so the returned text is the caption (or JSON, for the digital-twin caller),
  // not the caption with the model's reasoning glued to the front. Anchored to
  // the start so legitimate mid-text never gets clipped; the reasoning itself is
  // still surfaced via `reasoning` for the diagnostic.
  const rawContent = choice?.message?.content || '';
  return {
    text: rawContent.replace(/^\s*<think>[\s\S]*?<\/think>\s*/i, '').trim(),
    finishReason: choice?.finish_reason || null,
    usage: apiResponse.usage || null,
    reasoning: extractReasoning(choice?.message),
  };
}

/**
 * Run a comprehensive vision test suite
 * @param {string} [providerId='lmstudio'] - Provider to test
 * @param {string} [model] - Specific model to test
 * @returns {Promise<Object>} - Test suite results
 */
export async function runVisionTestSuite(providerId = 'lmstudio', model) {
  const results = [];
  const allFiles = await readdir(SCREENSHOTS_DIR).catch(() => []);
  const screenshotFiles = allFiles.filter(f =>
    /\.(png|jpg|jpeg|gif|webp)$/i.test(f)
  );

  if (screenshotFiles.length === 0) {
    return {
      success: false,
      error: 'No screenshots available for testing',
      results: []
    };
  }

  // Use first available screenshot for basic vision test
  const testImage = screenshotFiles[0];

  // Test 1: Basic image description
  const describeTest = await testVision({
    imagePath: testImage,
    prompt: 'Describe what you see in this image in 2-3 sentences. Focus on the main elements visible.',
    expectedContent: [], // No specific content expected, just verify it responds
    providerId,
    model
  }).catch(err => ({
    success: false,
    error: err.message,
    testName: 'basic-description'
  }));

  results.push({ ...describeTest, testName: 'basic-description' });

  // Test 2: UI element identification (if it's an app screenshot)
  const uiTest = await testVision({
    imagePath: testImage,
    prompt: 'If this is a screenshot of an application or website, identify any visible UI elements like buttons, forms, navigation, or text. If not a UI screenshot, describe the main subject.',
    expectedContent: [], // Just verify response quality
    providerId,
    model
  }).catch(err => ({
    success: false,
    error: err.message,
    testName: 'ui-identification'
  }));

  results.push({ ...uiTest, testName: 'ui-identification' });

  // Calculate overall success
  const successfulTests = results.filter(r => !r.error && r.response?.length > 20);

  return {
    success: successfulTests.length === results.length,
    totalTests: results.length,
    passedTests: successfulTests.length,
    provider: providerId,
    model: model || 'default',
    results
  };
}

/**
 * Quick health check for vision capabilities
 * @param {string} [providerId='lmstudio'] - Provider to check
 * @returns {Promise<Object>} - Health check result
 */
export async function checkVisionHealth(providerId = 'lmstudio') {
  let provider;
  try {
    provider = await getProviderById(providerId);
  } catch (err) {
    return { available: false, error: err.message };
  }

  if (!provider) {
    return { available: false, error: 'Provider not found' };
  }

  if (!provider.enabled) {
    return { available: false, error: 'Provider is disabled' };
  }

  if (provider.type !== 'api') {
    return { available: false, error: 'Vision requires API provider' };
  }

  // Check if endpoint is reachable
  const response = await fetchWithTimeout(`${provider.endpoint}/models`, {
    headers: provider.apiKey ? { 'Authorization': `Bearer ${provider.apiKey}` } : {}
  }, VISION_HEALTH_TIMEOUT_MS).catch(() => null);

  if (!response?.ok) {
    return { available: false, error: 'API endpoint not reachable' };
  }

  return {
    available: true,
    provider: providerId,
    endpoint: provider.endpoint,
    defaultModel: provider.defaultModel
  };
}
