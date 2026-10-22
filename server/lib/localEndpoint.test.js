import { describe, it, expect } from 'vitest';
import { isLoopbackEndpoint } from './localEndpoint.js';

describe('isLoopbackEndpoint', () => {
  it.each([
    ['localhost', true],
    ['localhost:11434', true],
    ['http://127.0.0.1', true],
    ['http://127.0.0.2:11434', true],
    ['http://[::1]', true],
    ['http://[::]:8080', true],
    ['http://0.0.0.0', true],
    ['http://192.0.2.10:11434', false],
    ['https://api.example.com/v1', false],
    ['http://localhost.example.com', false],
    ['', false],
    [undefined, false],
  ])('%s -> %s', (endpoint, expected) => {
    expect(isLoopbackEndpoint(endpoint)).toBe(expected);
  });
});
