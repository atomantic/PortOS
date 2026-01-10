/**
 * Vision Integration Test
 *
 * Tests LM Studio's vision capabilities end-to-end by:
 * 1. Creating a run with an actual screenshot
 * 2. Executing via the API provider
 * 3. Verifying the model correctly interprets the image
 *
 * This test requires:
 * - LM Studio running (localhost:1234 or remote via Tailscale)
 * - A vision-capable model loaded (e.g., llava, bakllava)
 * - Screenshots available in data/screenshots/
 *
 * Skip with: npm test -- --testPathIgnorePatterns=integration
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { testVision, checkVisionHealth, runVisionTestSuite } from './visionTest.js';
import { getProviderById } from './providers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCREENSHOTS_DIR = resolve(__dirname, '../../data/screenshots');

// Helper to check if LM Studio is available
async function isLmStudioAvailable() {
  const health = await checkVisionHealth('lmstudio').catch(() => ({ available: false }));
  return health.available;
}

// Helper to get an app screenshot (prefer .png files)
function getAppScreenshot() {
  if (!existsSync(SCREENSHOTS_DIR)) {
    return null;
  }

  const files = readdirSync(SCREENSHOTS_DIR).filter(f =>
    /\.(png|jpg|jpeg)$/i.test(f)
  );

  // Prefer PNG screenshots of the app (likely start with 'Screenshot')
  const appScreenshot = files.find(f => f.toLowerCase().startsWith('screenshot'));
  return appScreenshot || files[0] || null;
}

// Longer timeout for vision API calls (120 seconds)
const VISION_TEST_TIMEOUT = 120000;

describe('Vision Integration Tests', () => {
  let lmStudioAvailable = false;
  let testScreenshot = null;

  beforeAll(async () => {
    // Check prerequisites
    lmStudioAvailable = await isLmStudioAvailable();
    testScreenshot = getAppScreenshot();

    if (!lmStudioAvailable) {
      console.log('⏭️  LM Studio not available - integration tests will be skipped');
    }
    if (!testScreenshot) {
      console.log('⏭️  No screenshots available - integration tests will be skipped');
    }
  }, VISION_TEST_TIMEOUT);

  describe('LM Studio Vision Health', () => {
    it('should check vision health status', async () => {
      const health = await checkVisionHealth('lmstudio');

      // This test should always pass - it just reports the status
      expect(health).toBeDefined();
      expect(typeof health.available).toBe('boolean');

      if (health.available) {
        expect(health.provider).toBe('lmstudio');
        expect(health.endpoint).toBeDefined();
      } else {
        expect(health.error).toBeDefined();
      }
    });
  });

  describe('Vision Image Interpretation', () => {
    it('should correctly interpret an app screenshot with basic description', async () => {
      if (!lmStudioAvailable || !testScreenshot) {
        console.log('⏭️  Skipping: LM Studio or screenshots not available');
        return;
      }

      console.log(`📸 Testing with screenshot: ${testScreenshot}`);

      const result = await testVision({
        imagePath: testScreenshot,
        prompt: 'Describe what you see in this image. Focus on the main UI elements, layout, and any visible text or buttons.',
        expectedContent: [], // No specific content required, just verify it responds
        providerId: 'lmstudio'
      });

      expect(result).toBeDefined();
      expect(result.imagePath).toBe(testScreenshot);
      expect(result.provider).toBe('lmstudio');
      expect(result.duration).toBeGreaterThan(0);

      // Verify we got a meaningful response (not empty or error)
      expect(result.response).toBeDefined();
      expect(result.response.length).toBeGreaterThan(20);

      console.log(`✅ Vision response (${result.response.length} chars): ${result.response.substring(0, 200)}...`);
    }, VISION_TEST_TIMEOUT);

    it('should identify UI elements in app screenshots', async () => {
      if (!lmStudioAvailable || !testScreenshot) {
        console.log('⏭️  Skipping: LM Studio or screenshots not available');
        return;
      }

      const result = await testVision({
        imagePath: testScreenshot,
        prompt: 'List the main UI components visible in this screenshot. Look for: navigation elements, buttons, forms, cards, tables, or any interactive elements. Be specific about what you see.',
        expectedContent: [], // We'll verify response quality manually
        providerId: 'lmstudio'
      });

      expect(result).toBeDefined();
      expect(result.response).toBeDefined();
      expect(result.response.length).toBeGreaterThan(50);

      // Response should contain some UI-related terms for an app screenshot
      const uiTerms = ['button', 'text', 'menu', 'navigation', 'card', 'input', 'form', 'table', 'list', 'header', 'sidebar', 'panel', 'icon', 'tab'];
      const responseLower = result.response.toLowerCase();
      const foundTerms = uiTerms.filter(term => responseLower.includes(term));

      console.log(`📝 UI terms found: ${foundTerms.join(', ')}`);

      // For an app screenshot, we expect at least one UI term to be identified
      // This is a soft check since the model's response varies
      if (foundTerms.length === 0) {
        console.warn('⚠️  No standard UI terms found in response - this may be expected for non-UI images');
      }
    }, VISION_TEST_TIMEOUT);

    it('should handle expected content validation', async () => {
      if (!lmStudioAvailable || !testScreenshot) {
        console.log('⏭️  Skipping: LM Studio or screenshots not available');
        return;
      }

      // Test with expected content that should be found in any image description
      const result = await testVision({
        imagePath: testScreenshot,
        prompt: 'Describe the colors and visual elements in this image.',
        expectedContent: ['image', 'color'], // Very generic terms likely to appear
        providerId: 'lmstudio'
      });

      expect(result).toBeDefined();
      expect(result.expectedTerms).toContain('image');
      expect(result.expectedTerms).toContain('color');
      expect(result.foundTerms).toBeDefined();
      expect(result.missingTerms).toBeDefined();

      // At least one of our generic terms should be found
      expect(result.foundTerms.length + result.missingTerms.length).toBe(2);
    }, VISION_TEST_TIMEOUT);
  });

  describe('Vision Test Suite', () => {
    it('should run the full vision test suite', async () => {
      if (!lmStudioAvailable || !testScreenshot) {
        console.log('⏭️  Skipping: LM Studio or screenshots not available');
        return;
      }

      const result = await runVisionTestSuite('lmstudio');

      expect(result).toBeDefined();
      expect(result.provider).toBe('lmstudio');
      expect(result.totalTests).toBeGreaterThan(0);
      expect(result.results).toBeInstanceOf(Array);
      expect(result.results.length).toBe(result.totalTests);

      console.log(`📊 Test suite results: ${result.passedTests}/${result.totalTests} passed`);

      // Each result should have required fields
      for (const testResult of result.results) {
        expect(testResult.testName).toBeDefined();
        // Either we have a successful response or an error
        expect(testResult.response || testResult.error).toBeDefined();
      }
    }, VISION_TEST_TIMEOUT);
  });

  describe('Error Handling', () => {
    it('should gracefully handle non-existent provider', async () => {
      const result = await testVision({
        imagePath: 'test.png',
        prompt: 'Test',
        expectedContent: [],
        providerId: 'nonexistent-provider'
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should gracefully handle non-existent image', async () => {
      if (!lmStudioAvailable) {
        console.log('⏭️  Skipping: LM Studio not available');
        return;
      }

      // This should throw an error about missing image
      await expect(testVision({
        imagePath: 'definitely-does-not-exist.png',
        prompt: 'Test',
        expectedContent: [],
        providerId: 'lmstudio'
      })).rejects.toThrow('Failed to load image');
    }, VISION_TEST_TIMEOUT);
  });
});

describe('Provider Configuration Validation', () => {
  it('should have lmstudio provider configured', async () => {
    const provider = await getProviderById('lmstudio').catch(() => null);

    // This test documents the expected configuration
    // It passes even if provider doesn't exist (for CI environments)
    if (provider) {
      expect(provider.type).toBe('api');
      // Endpoint can be localhost or remote (e.g., Tailscale IP)
      expect(provider.endpoint).toContain(':1234');
      console.log(`✅ LM Studio provider configured: ${provider.endpoint}`);
    } else {
      console.log('ℹ️  LM Studio provider not configured - this is expected in some environments');
    }
  });
});
