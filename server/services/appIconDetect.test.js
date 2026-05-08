import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { detectAppIcon } from './appIconDetect.js';

const PNG_BYTES = Buffer.from('89504e470d0a1a0a', 'hex');

describe('detectAppIcon', () => {
  let repoPath;

  beforeEach(() => {
    repoPath = mkdtempSync(join(tmpdir(), 'icon-detect-'));
  });

  afterEach(() => {
    rmSync(repoPath, { recursive: true, force: true });
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
});
