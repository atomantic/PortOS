/**
 * Vision Test Service
 *
 * Tests LM Studio's vision capabilities by sending images to the API
 * and verifying the model can correctly interpret them.
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname, resolve, extname } from 'path';
import { fileURLToPath } from 'url';
import { getProviderById } from './providers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCREENSHOTS_DIR = resolve(__dirname, '../../data/screenshots');

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
  const fullPath = imagePath.startsWith('/') ? imagePath : join(SCREENSHOTS_DIR, imagePath);

  if (!existsSync(fullPath)) {
    throw new Error(`Image not found: ${fullPath}`);
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
 * @returns {Promise<Object>} - API response
 */
async function callVisionAPI({ endpoint, apiKey, model, imageDataUrl, prompt, timeout = 60000 }) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  const response = await fetch(`${endpoint}/chat/completions`, {
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
      max_tokens: 500,
      temperature: 0.1
    }),
    signal: controller.signal
  }).finally(() => clearTimeout(timeoutId));

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

  // Get provider configuration
  let provider;
  try {
    provider = await getProviderById(providerId);
  } catch (err) {
    return {
      success: false,
      error: err.message.includes('not initialized') ? `Provider '${providerId}' not found` : err.message,
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

  console.log(`🔍 Testing vision with model: ${testModel}`);
  console.log(`📸 Image: ${imagePath}`);

  // Call vision API
  const apiResponse = await callVisionAPI({
    endpoint: provider.endpoint,
    apiKey: provider.apiKey,
    model: testModel,
    imageDataUrl,
    prompt,
    timeout: provider.timeout || 60000
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
 * Run a comprehensive vision test suite
 * @param {string} [providerId='lmstudio'] - Provider to test
 * @param {string} [model] - Specific model to test
 * @returns {Promise<Object>} - Test suite results
 */
export async function runVisionTestSuite(providerId = 'lmstudio', model) {
  const results = [];
  const screenshotFiles = await import('fs').then(fs =>
    fs.readdirSync(SCREENSHOTS_DIR).filter(f =>
      /\.(png|jpg|jpeg|gif|webp)$/i.test(f)
    )
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
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  const response = await fetch(`${provider.endpoint}/models`, {
    headers: provider.apiKey ? { 'Authorization': `Bearer ${provider.apiKey}` } : {},
    signal: controller.signal
  }).catch(() => null).finally(() => clearTimeout(timeoutId));

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
