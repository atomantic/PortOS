import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mocks so promisify wraps the same fns we control in tests
const hoisted = vi.hoisted(() => ({
  execMock: vi.fn(),
  execFileMock: vi.fn()
}));

// Mock fs and child_process before importing
vi.mock('fs', () => ({
  existsSync: vi.fn()
}));
vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn()
}));
vi.mock('child_process', () => ({
  exec: hoisted.execMock,
  execFile: hoisted.execFileMock
}));
// promisify just returns the (already async) mock we control
vi.mock('util', () => ({
  promisify: (fn) => fn
}));

import {
  toBundleId, toTargetName, XCODE_BUNDLE_PREFIX,
  checkScripts, installScripts,
  generateDeployScript, generateScreenshotScript, generateMacScreenshotScript
} from './xcodeScripts.js';
import { existsSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';

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
      // First call checks repoPath exists (true), rest check script files (false)
      existsSync.mockImplementation((path) => path === '/tmp/test');
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

    it('should return empty arrays when repoPath does not exist', () => {
      existsSync.mockReturnValue(false);
      const result = checkScripts({ type: 'xcode', repoPath: '/nonexistent' });
      expect(result.missing).toHaveLength(0);
      expect(result.present).toHaveLength(0);
    });

    it('should work for ios-native type', () => {
      existsSync.mockImplementation((path) => path === '/tmp/test');
      const result = checkScripts({ type: 'ios-native', repoPath: '/tmp/test' });
      expect(result.missing.length).toBeGreaterThan(0);
    });

    it('should work for macos-native type', () => {
      existsSync.mockImplementation((path) => path === '/tmp/test');
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
      // Must match a literal ~ (not \~), otherwise ~/... paths won't expand at runtime
      expect(script).toContain('KEY_PATH="${KEY_PATH/#~/$HOME}"');
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

  describe('installScripts', () => {
    beforeEach(() => {
      hoisted.execMock.mockReset();
      hoisted.execFileMock.mockReset();
      readFile.mockReset();
      writeFile.mockReset();
      // Default: chmod succeeds, ls returns nothing
      hoisted.execFileMock.mockResolvedValue({ stdout: '', stderr: '' });
      hoisted.execMock.mockResolvedValue({ stdout: '', stderr: '' });
      writeFile.mockResolvedValue(undefined);
    });

    it('returns error for non-Xcode app type', async () => {
      const result = await installScripts({ type: 'node', repoPath: '/tmp/x' }, ['deploy.sh']);
      expect(result.installed).toHaveLength(0);
      expect(result.errors).toContain('Not an Xcode app');
    });

    it('returns error when app has no repoPath', async () => {
      const result = await installScripts({ type: 'xcode' }, ['deploy.sh']);
      expect(result.errors).toContain('Not an Xcode app');
    });

    it('reports unknown script names as errors', async () => {
      // No project.yml, no .xcodeproj — falls through to appName-based naming
      existsSync.mockImplementation(() => false);
      const result = await installScripts(
        { type: 'xcode', repoPath: '/tmp/x', name: 'MyApp' },
        ['nonsense.sh']
      );
      expect(result.errors).toContain('Unknown script: nonsense.sh');
      expect(result.installed).toHaveLength(0);
    });

    it('skips scripts that already exist (never overwrites)', async () => {
      // project.yml does not exist; deploy.sh DOES exist
      existsSync.mockImplementation((p) => String(p).endsWith('deploy.sh'));
      const result = await installScripts(
        { type: 'xcode', repoPath: '/tmp/x', name: 'MyApp' },
        ['deploy.sh']
      );
      expect(result.skipped).toContain('deploy.sh');
      expect(result.installed).toHaveLength(0);
      expect(writeFile).not.toHaveBeenCalled();
    });

    it('installs missing scripts and chmods them', async () => {
      // No project.yml, no existing scripts, no .env.example
      existsSync.mockImplementation(() => false);
      const result = await installScripts(
        { type: 'xcode', repoPath: '/tmp/x', name: 'MyApp' },
        ['deploy.sh', 'take_screenshots.sh']
      );
      expect(result.installed).toEqual(['deploy.sh', 'take_screenshots.sh']);
      expect(result.skipped).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
      // writeFile called for each script + .env.example (since deploy.sh installed)
      expect(writeFile).toHaveBeenCalledTimes(3);
      // chmod called once with both installed paths
      expect(hoisted.execFileMock).toHaveBeenCalledWith(
        'chmod',
        expect.arrayContaining(['+x', '/tmp/x/deploy.sh', '/tmp/x/take_screenshots.sh'])
      );
    });

    it('does not create .env.example when one already exists', async () => {
      existsSync.mockImplementation((p) => String(p).endsWith('.env.example'));
      await installScripts(
        { type: 'xcode', repoPath: '/tmp/x', name: 'MyApp' },
        ['deploy.sh']
      );
      // writeFile only called once (deploy.sh) — not for .env.example
      expect(writeFile).toHaveBeenCalledTimes(1);
      const calls = writeFile.mock.calls.map(c => c[0]);
      expect(calls).not.toContain('/tmp/x/.env.example');
    });

    it('derives target name and bundle id from project.yml', async () => {
      existsSync.mockImplementation((p) => String(p).endsWith('project.yml'));
      readFile.mockResolvedValue([
        'name: CustomTarget',
        'targets:',
        '  CustomTarget:',
        '    settings:',
        '      PRODUCT_BUNDLE_IDENTIFIER: net.example.CustomTarget',
        '  CustomTargetTests:',
        '    settings:',
        '      PRODUCT_BUNDLE_IDENTIFIER: net.example.CustomTargetTests'
      ].join('\n'));

      await installScripts(
        { type: 'xcode', repoPath: '/tmp/x', name: 'IgnoredAppName' },
        ['deploy.sh']
      );

      // First writeFile call is the deploy script
      const deployScript = writeFile.mock.calls[0][1];
      expect(deployScript).toContain('CustomTarget');
      // Test target bundle id should be skipped — verify the non-test one is used
      expect(deployScript).not.toContain('IgnoredAppName');
    });

    it('skips watchkitapp and Tests bundle ids in project.yml parsing', async () => {
      existsSync.mockImplementation((p) => String(p).endsWith('project.yml'));
      readFile.mockResolvedValue([
        'name: MyApp',
        '    PRODUCT_BUNDLE_IDENTIFIER: net.example.MyAppTests',
        '    PRODUCT_BUNDLE_IDENTIFIER: net.example.MyApp.watchkitapp',
        '    PRODUCT_BUNDLE_IDENTIFIER: net.example.MyApp'
      ].join('\n'));

      await installScripts(
        { type: 'xcode', repoPath: '/tmp/x', name: 'MyApp' },
        ['take_screenshots.sh']
      );

      const screenshotScript = writeFile.mock.calls[0][1];
      // The non-Tests, non-watchkit id should be selected
      expect(screenshotScript).toContain('net.example.MyApp');
      expect(screenshotScript).not.toContain('watchkitapp');
    });

    it('strips wrapping quotes from project.yml scalar values', async () => {
      existsSync.mockImplementation((p) => String(p).endsWith('project.yml'));
      readFile.mockResolvedValue([
        'name: "QuotedName"',
        '    PRODUCT_BUNDLE_IDENTIFIER: "net.example.Quoted"'
      ].join('\n'));

      await installScripts(
        { type: 'xcode', repoPath: '/tmp/x', name: 'IgnoredAppName' },
        ['deploy.sh']
      );

      const script = writeFile.mock.calls[0][1];
      // Quotes should be stripped before interpolation — header comment uses
      // raw target name, so it should appear as `QuotedName`, not `"QuotedName"`.
      expect(script).toContain('# QuotedName - Local TestFlight Deploy');
    });

    it('rejects unsafe target names from project.yml and falls back to app name', async () => {
      existsSync.mockImplementation((p) => String(p).endsWith('project.yml'));
      // Name with shell metacharacters should be rejected by the safety regex
      readFile.mockResolvedValue('name: "Bad$Name;rm"\n');

      await installScripts(
        { type: 'xcode', repoPath: '/tmp/x', name: 'SafeApp' },
        ['deploy.sh']
      );

      const script = writeFile.mock.calls[0][1];
      expect(script).toContain('SafeApp');
      expect(script).not.toContain('Bad$Name');
    });

    it('falls back to .xcodeproj directory name when project.yml absent', async () => {
      // No project.yml; deriveProjectInfo executes `ls -d *.xcodeproj`
      existsSync.mockImplementation(() => false);
      hoisted.execMock.mockResolvedValue({ stdout: 'FoundProject.xcodeproj\n', stderr: '' });

      await installScripts(
        { type: 'xcode', repoPath: '/tmp/x', name: 'IgnoredAppName' },
        ['deploy.sh']
      );

      const script = writeFile.mock.calls[0][1];
      expect(script).toContain('FoundProject');
      expect(script).not.toContain('IgnoredAppName');
    });

    it('falls back to app name when neither project.yml nor .xcodeproj is present', async () => {
      existsSync.mockImplementation(() => false);
      hoisted.execMock.mockResolvedValue({ stdout: '', stderr: '' });

      await installScripts(
        { type: 'xcode', repoPath: '/tmp/x', name: 'BareApp' },
        ['deploy.sh']
      );

      const script = writeFile.mock.calls[0][1];
      expect(script).toContain('BareApp');
    });

    it('reports chmod failure as a non-fatal error', async () => {
      existsSync.mockImplementation(() => false);
      hoisted.execFileMock.mockRejectedValue(new Error('permission denied'));

      const result = await installScripts(
        { type: 'xcode', repoPath: '/tmp/x', name: 'MyApp' },
        ['deploy.sh']
      );

      expect(result.installed).toContain('deploy.sh');
      expect(result.errors.some(e => e.includes('chmod failed'))).toBe(true);
    });

    it('emits Windows-specific message when running on win32', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32' });
      try {
        existsSync.mockImplementation(() => false);
        const result = await installScripts(
          { type: 'xcode', repoPath: 'C:/tmp/x', name: 'MyApp' },
          ['deploy.sh']
        );
        // deriveProjectInfo short-circuits on win32 — uses appName directly
        expect(result.installed).toContain('deploy.sh');
        expect(result.errors.some(e => e.includes('chmod is not supported on Windows'))).toBe(true);
        // execFile should NOT have been called for chmod on Windows
        expect(hoisted.execFileMock).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform });
      }
    });
  });
});
