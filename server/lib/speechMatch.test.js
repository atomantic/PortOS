import { describe, it, expect } from 'vitest';
import { compareSpeech, normalizeSpeech, numberToWords } from './speechMatch.js';

describe('speechMatch', () => {
  it('spells numbers', () => {
    expect(numberToWords(12)).toBe('twelve');
    expect(numberToWords(0)).toBe('zero');
    expect(numberToWords(2024)).toBe('two thousand twenty four');
    expect(numberToWords(1_250_300)).toBe('one million two hundred fifty thousand three hundred');
  });

  it.each([
    ['I have 12 apples.', 'I have twelve apples'],
    ['Hello, World!', 'hello world'],
    ["Don't go.", 'Dont go'],
    ['It cost 1,200 dollars', 'it cost one thousand two hundred dollars'],
    ['In 1999 we left', 'In nineteen ninety nine we left'],
    ['3.5 miles', 'three point five miles'],
    ['你好，世界！', '你好 世界'],
  ])('matches %j against %j', (script, heard) => {
    expect(compareSpeech(script, heard).status).toBe('matched');
  });

  it.each([
    ['I have 12 apples', 'I have fifteen apples'],
    ['The quick brown fox jumps over the lazy dog', 'The quick brown fox jumps'],
    ['你好世界今天天气很好', '你好世界明天下雨'],
    ['Say something', ''],
  ])('flags %j heard as %j', (script, heard) => {
    expect(compareSpeech(script, heard).status).toBe('mismatch');
  });

  it('tokenizes CJK per character and Latin per word', () => {
    expect(normalizeSpeech('你好 世界')).toEqual(['你', '好', '世', '界']);
    expect(normalizeSpeech('Hi, there')).toEqual(['hi', 'there']);
  });
});
