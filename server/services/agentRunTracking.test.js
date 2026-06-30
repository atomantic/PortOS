import { describe, expect, it } from 'vitest';
import { extractErrorFromOutput } from './agentRunTracking.js';

// extractErrorFromOutput is the real home of the exit-code → message mapping
// and the output error-pattern scan. subAgentSpawner.test.js used to assert an
// inline `exitCodeMessages` literal copy that exercised no production code.
describe('extractErrorFromOutput', () => {
  describe('empty output — exit-code mapping', () => {
    it.each([
      [1, 'General error (exit code 1)', 'unknown'],
      [2, 'Misuse of shell command (exit code 2)', 'unknown'],
      [126, 'Command invoked cannot execute (permission or not executable) (exit code 126)', 'unknown'],
      [127, 'Command not found (exit code 127)', 'unknown'],
      [130, 'Script terminated by Ctrl+C (exit code 130)', 'unknown'],
      [137, 'Process killed (SIGKILL) (exit code 137)', 'unknown'],
      [143, 'Process terminated (SIGTERM - likely timeout) (exit code 143)', 'timeout']
    ])('maps exit code %i to a readable message and category', (code, message, category) => {
      const result = extractErrorFromOutput('', code);
      expect(result.message).toBe(message);
      expect(result.category).toBe(category);
      expect(result.details).toBe(`Process exited with code ${code}. No output was captured.`);
    });

    it('falls back to "Unknown error" for an unmapped exit code', () => {
      const result = extractErrorFromOutput('', 99);
      expect(result.message).toBe('Unknown error (exit code 99)');
      expect(result.category).toBe('unknown');
    });

    it('treats whitespace-only output as empty', () => {
      const result = extractErrorFromOutput('   \n  \t\n', 1);
      expect(result.message).toBe('General error (exit code 1)');
    });
  });

  describe('non-empty output — error-pattern extraction', () => {
    it('categorizes an API error line', () => {
      const result = extractErrorFromOutput('starting up\nAPI Error: 429 too many requests', 1);
      expect(result.category).toBe('api-error');
      expect(result.message).toContain('API Error: 429');
    });

    it('categorizes a permission-denied line', () => {
      const result = extractErrorFromOutput('running task\npermission denied: /etc/shadow', 126);
      expect(result.category).toBe('permission');
      expect(result.message).toContain('permission denied');
    });

    it('categorizes a connection-refused line', () => {
      const result = extractErrorFromOutput('working\nconnection refused by upstream service', 1);
      expect(result.category).toBe('connection');
    });

    it('categorizes a timeout line', () => {
      const result = extractErrorFromOutput('working\noperation timeout after 600s', 1);
      expect(result.category).toBe('timeout');
    });

    it('keeps category "unknown" and returns the output when nothing matches', () => {
      const result = extractErrorFromOutput('all quiet on the western front today', 1);
      expect(result.category).toBe('unknown');
      expect(result.message).toBe('all quiet on the western front today');
    });
  });
});
