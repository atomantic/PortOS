import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs and child_process before importing
vi.mock('fs', () => ({
  existsSync: vi.fn()
}));
vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn()
}));
vi.mock('child_process', () => ({
  exec: vi.fn(),
  execFile: vi.fn()
}));
vi.mock('util', () => ({
  promisify: vi.fn((fn) => vi.fn())
}));

import {
  toBundleId, toTargetName, XCODE_BUNDLE_PREFIX,
  checkScripts, installScripts,
  generateDeployScript, generateScreenshotScript, generateMacScreenshotScript
} from './xcodeScripts.js';
import { existsSync } from 'fs';

describe('xcodeScripts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('toBundleId', () => {
    it('should generate valid bundle ID from name', () => {
      expect(toBundleId('MyApp')).toBe(`${XCODE_BUNDLE_PREFIX}.MyApp`);
    });

    it('should strip non-alphanumeric characters', () => {
      expect(toBundleId('My App!')).toBe(`${XCODE_BUNDLE_PREFIX}.MyApp`);
    });

    it('should fall back to "app" when name has no alphanumeric characters', () => {
      expect(toBundleId('---')).toBe(`${XCODE_BUNDLE_PREFIX}.app`);
    });

    it('should handle empty string', () => {
      expect(toBundleId('')).toBe(`${XCODE_BUNDLE_PREFIX}.app`);
    });
  });

  describe('toTargetName', () => {
    it('should replace non-alphanumeric/underscore chars with underscore', () => {
      expect(toTargetName('My App')).toBe('My_App');
    });

    it('should preserve underscores', () => {
      expect(toTargetName('My_App')).toBe('My_App');
    });

    it('should handle already clean names', () => {
      expect(toTargetName('MyApp')).toBe('MyApp');
    });
  });

  describe('checkScripts', () => {
    it('should return empty arrays for non-Xcode app types', () => {
      const result = checkScripts({ type: 'node', repoPath: '/tmp/test' });
      expect(result.missing).toHaveLength(0);
      expect(result.present).toHaveLength(0);
    });

    it('should return empty arrays for swift (SPM) app type', () => {
      const result = checkScripts({ type: 'swift', repoPath: '/tmp/test' });
      expect(result.missing).toHaveLength(0);
      expect(result.present).toHaveLength(0);
    });

    it('should return empty arrays when app has no repoPath', () => {
      const result = checkScripts({ type: 'xcode' });
      expect(result.missing).toHaveLength(0);
    });

    it('should detect missing scripts for xcode apps', () => {
      existsSync.mockReturnValue(false);
      const result = checkScripts({ type: 'xcode', repoPath: '/tmp/test' });
      expect(result.missing.length).toBeGreaterThan(0);
      expect(result.present).toHaveLength(0);
    });

    it('should detect present scripts for xcode apps', () => {
      existsSync.mockReturnValue(true);
      const result = checkScripts({ type: 'xcode', repoPath: '/tmp/test' });
      expect(result.present.length).toBeGreaterThan(0);
      expect(result.missing).toHaveLength(0);
    });

    it('should work for ios-native type', () => {
      existsSync.mockReturnValue(false);
      const result = checkScripts({ type: 'ios-native', repoPath: '/tmp/test' });
      expect(result.missing.length).toBeGreaterThan(0);
    });

    it('should work for macos-native type', () => {
      existsSync.mockReturnValue(false);
      const result = checkScripts({ type: 'macos-native', repoPath: '/tmp/test' });
      expect(result.missing.length).toBeGreaterThan(0);
    });
  });

  describe('generateDeployScript', () => {
    it('should generate a bash script with target name', () => {
      const script = generateDeployScript('MyApp', 'net.test.MyApp');
      expect(script).toContain('#!/bin/bash');
      expect(script).toContain('MyApp');
      expect(script).toContain('--ios');
      expect(script).toContain('--macos');
      expect(script).toContain('--watch');
    });

    it('should include tilde expansion for KEY_PATH', () => {
      const script = generateDeployScript('MyApp', 'net.test.MyApp');
      expect(script).toContain('KEY_PATH/#');
    });

    it('should only run tests when building iOS', () => {
      const script = generateDeployScript('MyApp', 'net.test.MyApp');
      expect(script).toContain('$BUILD_IOS; then');
    });
  });

  describe('generateScreenshotScript', () => {
    it('should generate a bash script for iOS screenshots', () => {
      const script = generateScreenshotScript('MyApp', 'net.test.MyApp');
      expect(script).toContain('#!/bin/bash');
      expect(script).toContain('MyApp');
      expect(script).toContain('net.test.MyApp');
    });

    it('should include dynamic iOS version detection', () => {
      const script = generateScreenshotScript('MyApp', 'net.test.MyApp');
      expect(script).toContain('IOS_VERSION=');
      expect(script).toContain('simctl list runtimes');
    });
  });

  describe('generateMacScreenshotScript', () => {
    it('should generate a bash script for macOS screenshots', () => {
      const script = generateMacScreenshotScript('MyApp', 'net.test.MyApp');
      expect(script).toContain('#!/bin/bash');
      expect(script).toContain('MyApp');
    });
  });
});
