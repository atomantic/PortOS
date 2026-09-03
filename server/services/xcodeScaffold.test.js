import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readdir, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, relative, sep } from 'path';

// xcodegen is an external binary that may or may not exist on the machine
// running the suite — stub the spawn so the scaffolder's file emission is what
// is under test, not the generator's availability.
vi.mock('../lib/childProcess.js', async importOriginal => ({
  ...await importOriginal(),
  exec: vi.fn((cmd, opts, cb) => cb(null, { stdout: 'Created project', stderr: '' }))
}));

import { scaffoldXcode } from './xcodeScaffold.js';

/** Every emitted file, repo-relative with POSIX separators, sorted. */
async function listFiles(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter(e => e.isFile())
    .map(e => relative(root, join(e.parentPath ?? e.path, e.name)).split(sep).join('/'))
    .sort();
}

describe('scaffoldXcode', () => {
  let repoPath;
  const steps = [];
  const addStep = (name, status) => steps.push([name, status]);

  beforeEach(async () => {
    steps.length = 0;
    repoPath = await mkdtemp(join(tmpdir(), 'portos-xcode-scaffold-'));
  });

  afterEach(async () => {
    await rm(repoPath, { recursive: true, force: true });
  });

  it('emits an iOS-only project for platforms: ["ios"]', async () => {
    await scaffoldXcode(repoPath, 'Sample App', 'sample-app', addStep, { platforms: ['ios'] });

    expect(await listFiles(repoPath)).toEqual([
      '.env.example',
      'AGENTS.md', 'CLAUDE.md', // AGENTS.md is canonical; CLAUDE.md is its one-line bridge
      'Sample_App/Assets.xcassets/AppIcon.appiconset/Contents.json',
      'Sample_App/Assets.xcassets/Contents.json',
      'Sample_App/ContentView.swift',
      'Sample_App/Info.plist',
      'Sample_App/Preview Content/PreviewAssets.xcassets/Contents.json',
      'Sample_App/Sample_AppApp.swift',
      'Sample_AppTests/Sample_AppTests.swift',
      'deploy.sh',
      'project.yml',
    ]);

    const projectYml = await readFile(join(repoPath, 'project.yml'), 'utf8');
    expect(projectYml).toContain('  Sample_App:\n    type: application\n    platform: iOS');
    expect(projectYml).toContain('  Sample_AppTests:');
    expect(projectYml).not.toContain('macOS');
    expect(projectYml).not.toContain('watchOS');
    expect(projectYml).not.toContain('UITests');
    // No Shared module means ContentView must not reference AppConstants.
    expect(await readFile(join(repoPath, 'Sample_App/ContentView.swift'), 'utf8'))
      .not.toContain('AppConstants');
    expect(steps).toContainEqual(['Create iOS project', 'done']);
  });

  it('emits iOS + macOS + watchOS targets by default', async () => {
    await scaffoldXcode(repoPath, 'Sample App', 'sample-app', addStep);

    const files = await listFiles(repoPath);
    expect(files).toContain('Shared/AppConstants.swift');
    expect(files).toContain('Sample_App_Watch/WatchContentView.swift');
    expect(files).toContain('Sample_App-macOS.entitlements');
    expect(files).toContain('Sample_AppUITests/ScreenshotTests.swift');
    expect(files).toContain('take_screenshots.sh');
    expect(files).toContain('take_screenshots_macos.sh');

    const projectYml = await readFile(join(repoPath, 'project.yml'), 'utf8');
    expect(projectYml).toContain('  Sample_App:\n    type: application\n    platform: iOS');
    expect(projectYml).toContain('  Sample_App macOS:\n    type: application\n    platform: macOS');
    expect(projectYml).toContain('  Sample_App_Watch:\n    type: application\n    platform: watchOS');
    expect(projectYml).toContain('  Sample_AppTests:');
    expect(projectYml).toContain('  Sample_AppUITests:');
    expect(steps).toContainEqual(['Create multi-platform Xcode project', 'done']);
  });
});
