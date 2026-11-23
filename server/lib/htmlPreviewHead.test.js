import { describe, expect, it } from 'vitest';
import { injectPreviewHead } from './htmlPreviewHead.js';

const MARKUP = '<meta name="preview">';

describe('injectPreviewHead', () => {
  it('accepts only the opening tokens of a complete prologue, retaining their spelling and attributes', () => {
    const prologue = ` \n<!DOCTYPE html>\n<!-- <head> -->\n<HTML lang=en data-example="a > b <head>">\n<!-- heading -->\n<HeAd data-example='>' data-flag>`;
    const rest = '<title>Preview</title></head><body><p>Text</p></body></html>';
    expect(injectPreviewHead(`\uFEFF${prologue}${rest}`, MARKUP)).toBe(`${prologue}${MARKUP}${rest}`);
  });

  it.each([
    '<!-- unfinished <head>',
    '<!--- so far --> <style>p { color: teal }</style><head>',
    '<!--> <p>Preview text</p> --> <head>',
    '<!-- note --!> <p>Preview text</p> --> <head>',
    '<html data-example="unfinished <head>',
    '<headings><head>',
    '<html>\u00a0<head>',
  ])('puts the trusted head first for %s', (html) => {
    expect(injectPreviewHead(`<!DOCTYPE html>${html}`, MARKUP)).toBe(`<!DOCTYPE html><head>${MARKUP}</head>${html}`);
  });
});
