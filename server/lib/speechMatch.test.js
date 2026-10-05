import { describe, it, expect } from 'vitest';
import { compareSpeech } from './speechMatch.js';

describe('speechMatch', () => {
  it.each([
    ['I have 12 apples.', 'I have twelve apples'],
    ['Hello, World!', 'hello world'],
    ["Don't go.", 'Dont go'],
    ['It cost 1,200 dollars', 'it cost one thousand two hundred dollars'],
    ['In 1999 we left', 'In nineteen ninety nine we left'],
    ['3.5 miles', 'three point five miles'],
    ['1,250,300 people', 'one million two hundred fifty thousand three hundred people'],
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

});
