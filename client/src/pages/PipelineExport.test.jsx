import { describe, it, expect } from 'vitest';
import { TRIM_SIZES, INTERIOR_FONTS } from '../lib/proseExportSettings.js';
import { TRIM_SIZE_LABELS, FONT_LABELS } from './PipelineExport.jsx';

// A trim size or font added server-side without a label here would render a blank option.
describe('PipelineExport labels', () => {
  it('has exactly one label per server trim size', () => {
    expect(Object.keys(TRIM_SIZE_LABELS).sort()).toEqual(Object.keys(TRIM_SIZES).sort());
  });

  it('has exactly one label per server interior font', () => {
    expect(Object.keys(FONT_LABELS).sort()).toEqual([...INTERIOR_FONTS].sort());
  });
});
