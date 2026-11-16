import { describe, it, expect } from 'vitest';
import { verticalTargetSize, isAlreadyTallEnough, verticalFilterGraph } from './verticalReframe.js';

describe('verticalReframe geometry', () => {
  it('sizes each ratio at 720 wide with even dimensions', () => {
    expect(verticalTargetSize('9:16')).toEqual({ width: 720, height: 1280 });
    expect(verticalTargetSize('4:5')).toEqual({ width: 720, height: 900 });
    expect(verticalTargetSize('1:1')).toEqual({ width: 720, height: 720 });
    expect(verticalTargetSize('16:9')).toBeNull();
  });

  it('refuses a clip already as tall as the target', () => {
    expect(isAlreadyTallEnough(1280, 720, '9:16')).toBe(false);
    expect(isAlreadyTallEnough(720, 1280, '9:16')).toBe(true);
    expect(isAlreadyTallEnough(1080, 1350, '4:5')).toBe(true);
    expect(isAlreadyTallEnough(1280, 720, '1:1')).toBe(false);
    expect(isAlreadyTallEnough(800, 800, '1:1')).toBe(true);
    expect(isAlreadyTallEnough(720, 1280, '4:5')).toBe(true);
  });

  it('builds a cover-blur background under a width-fit centred foreground', () => {
    const graph = verticalFilterGraph('9:16');
    expect(graph).toContain('scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280');
    expect(graph).toContain('boxblur=30:2');
    expect(graph).toContain('[fgsrc]scale=720:-2[fg]');
    expect(graph).toContain('overlay=(W-w)/2:(H-h)/2,format=yuv420p[outv]');
    expect(verticalFilterGraph('1:1')).toContain('crop=720:720');
    expect(verticalFilterGraph('nope')).toBeNull();
  });
});
