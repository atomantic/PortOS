import { describe, it, expect } from 'vitest';
import { generateQrCodeSvg } from './qrCode.js';

describe('generateQrCodeSvg', () => {
  it('generates valid SVG for a URL string', () => {
    const url = 'https://host.ts.net:5555/fableloom/join#session=123&token=abc';
    const svg = generateQrCodeSvg(url, { size: 240 });

    expect(svg).toContain('<svg');
    expect(svg).toContain('viewBox="0 0 240 240"');
    expect(svg).toContain('</svg>');
    expect(svg).toContain('<rect');
  });

  it('handles empty input gracefully', () => {
    const svg = generateQrCodeSvg('', { size: 100 });
    expect(svg).toContain('<svg');
    expect(svg).toContain('viewBox="0 0 100 100"');
  });
});
