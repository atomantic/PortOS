import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { detectAppIcon } from './appIconDetect.js';

const PNG_BYTES = Buffer.from('89504e470d0a1a0a', 'hex');

describe('detectAppIcon', () => {
  let repoPath;
  let scratch;

  beforeEach(() => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), 'icon-detect-')));
    repoPath = join(scratch, 'repo');
    mkdirSync(repoPath);
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('returns null for missing repoPath', async () => {
    expect(await detectAppIcon('', 'express')).toBe(null);
    expect(await detectAppIcon('/no/such/path', 'express')).toBe(null);
  });

  it('finds favicon.svg in client/public', async () => {
    mkdirSync(join(repoPath, 'client', 'public'), { recursive: true });
    writeFileSync(join(repoPath, 'client', 'public', 'favicon.svg'), '<svg><circle/></svg>');
    const result = await detectAppIcon(repoPath, 'express');
    expect(result).toBe(join(repoPath, 'client', 'public', 'favicon.svg'));
  });

  // Regression: PortOS shipped a favicon.svg containing
  // `<image href="/portos-logo.png">`. The icon endpoint serves SVG with a
  // strict `default-src 'none'` CSP, so the embedded raster is blocked and
  // the icon renders blank. Detector must skip SVGs that pull external
  // resources and fall through to a self-contained sibling.
  it('skips SVGs that embed external <image href> and falls through to PNG', async () => {
    mkdirSync(join(repoPath, 'client', 'public'), { recursive: true });
    writeFileSync(
      join(repoPath, 'client', 'public', 'favicon.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">' +
        '<image href="/portos-logo.png" width="512" height="512"/>' +
        '</svg>'
    );
    writeFileSync(join(repoPath, 'client', 'public', 'apple-touch-icon.png'), PNG_BYTES);
    const result = await detectAppIcon(repoPath, 'express');
    expect(result).toBe(join(repoPath, 'client', 'public', 'apple-touch-icon.png'));
  });

  it('keeps an SVG that uses inline data: image hrefs', async () => {
    mkdirSync(join(repoPath, 'public'), { recursive: true });
    writeFileSync(
      join(repoPath, 'public', 'favicon.svg'),
      '<svg><image href="data:image/png;base64,AAAA"/></svg>'
    );
    const result = await detectAppIcon(repoPath, 'express');
    expect(result).toBe(join(repoPath, 'public', 'favicon.svg'));
  });

  it('ranks only contained PNG members in an Xcode manifest', async () => {
    const iconSet = join(repoPath, 'Assets.xcassets', 'AppIcon.appiconset');
    mkdirSync(iconSet, { recursive: true });
    writeFileSync(join(scratch, 'outside.png'), PNG_BYTES);
    writeFileSync(join(iconSet, 'small.png'), PNG_BYTES);
    writeFileSync(join(iconSet, 'large.png'), PNG_BYTES);
    writeFileSync(join(iconSet, 'Contents.json'), JSON.stringify({ images: [
      { filename: '../../../outside.png', size: '4096x4096', scale: '1x' },
      { filename: 'small.png', size: '128x128', scale: '1x' },
      { filename: 'large.png', size: '256x256', scale: '2x' },
    ] }));

    expect(await detectAppIcon(repoPath, 'xcode')).toBe(join(iconSet, 'large.png'));
  });

  it('falls back to contained PNG files when a manifest has the wrong images shape', async () => {
    const iconSet = join(repoPath, 'Assets.xcassets', 'AppIcon.appiconset');
    mkdirSync(iconSet, { recursive: true });
    writeFileSync(join(iconSet, 'icon.png'), PNG_BYTES);
    writeFileSync(join(iconSet, 'Contents.json'), JSON.stringify({ images: { filename: 'icon.png' } }));

    expect(await detectAppIcon(repoPath, 'xcode')).toBe(join(iconSet, 'icon.png'));
  });

  it('ignores an external manifest symlink and uses the local fallback', async () => {
    const iconSet = join(repoPath, 'Assets.xcassets', 'AppIcon.appiconset');
    mkdirSync(iconSet, { recursive: true });
    writeFileSync(join(iconSet, 'a.png'), PNG_BYTES);
    writeFileSync(join(iconSet, 'z.png'), PNG_BYTES);
    const externalManifest = join(scratch, 'manifest.json');
    writeFileSync(externalManifest, JSON.stringify({ images: [{ filename: 'a.png', size: '1024x1024' }] }));
    symlinkSync(externalManifest, join(iconSet, 'Contents.json'), 'file');

    // The external manifest would pick a.png; filename fallback picks z.png.
    expect(await detectAppIcon(repoPath, 'xcode')).toBe(join(iconSet, 'z.png'));
  });
});
