import { describe, it, expect } from 'vitest';
import { renderOrPrependSection } from './promptSectionRenderer.js';

describe('renderOrPrependSection', () => {
  it('replaces a token when present in the prompt', () => {
    const prompt = 'Here is the content:\n\n{userActionDelivery}\n\nAnd more.';
    const block = 'Block content';
    const result = renderOrPrependSection(prompt, '{userActionDelivery}', 'Delivery mode', block);
    expect(result).toBe('Here is the content:\n\nBlock content\n\nAnd more.');
  });

  it('prepends the block with a heading when token is absent', () => {
    const prompt = 'Original prompt content';
    const block = 'Block content';
    const result = renderOrPrependSection(prompt, '{userActionDelivery}', 'Delivery mode', block);
    expect(result).toBe('## Delivery mode\n\nBlock content\n\n---\n\nOriginal prompt content');
  });

  it('prepends without a heading when heading is null', () => {
    const prompt = 'Original prompt content';
    const block = 'Block content';
    const result = renderOrPrependSection(prompt, '{modeInstructions}', null, block);
    expect(result).toBe('Block content\n\n---\n\nOriginal prompt content');
  });

  it('handles block containing $& (regex replacement hazard) when token is present', () => {
    const prompt = 'Before {token} after';
    const block = 'Contains $& and $1 and $` and $\' characters';
    const result = renderOrPrependSection(prompt, '{token}', 'Section', block);
    // Should insert the block verbatim, not interpret $& as a backreference
    expect(result).toBe('Before Contains $& and $1 and $` and $\' characters after');
  });

  it('handles block containing $& when token is absent (prepending)', () => {
    const prompt = 'Original';
    const block = 'Contains $& and $1 and $` and $\' characters';
    const result = renderOrPrependSection(prompt, '{token}', 'Section', block);
    expect(result).toBe('## Section\n\nContains $& and $1 and $` and $\' characters\n\n---\n\nOriginal');
  });

  it('handles non-string prompt gracefully', () => {
    const result = renderOrPrependSection(null, '{token}', 'Heading', 'Block');
    expect(result).toBe('## Heading\n\nBlock\n\n---\n\n');
  });

  it('handles empty string prompt', () => {
    const result = renderOrPrependSection('', '{token}', 'Heading', 'Block');
    expect(result).toBe('## Heading\n\nBlock\n\n---\n\n');
  });

  it('handles multiple occurrences of the token', () => {
    const prompt = 'First {token} and second {token}';
    const block = 'CONTENT';
    const result = renderOrPrependSection(prompt, '{token}', 'Heading', block);
    expect(result).toBe('First CONTENT and second CONTENT');
  });

  it('handles special regex characters in token name', () => {
    const prompt = 'Before {release.options} after';
    const block = 'Block';
    const result = renderOrPrependSection(prompt, '{release.options}', 'Heading', block);
    expect(result).toBe('Before Block after');
  });
});
