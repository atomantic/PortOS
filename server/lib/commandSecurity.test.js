import { describe, it, expect } from 'vitest'
import {
  ALLOWED_COMMANDS,
  ALLOWED_COMMANDS_SORTED,
  DANGEROUS_SHELL_CHARS,
  validateCommand,
  redactOutput
} from './commandSecurity.js'

describe('commandSecurity', () => {
  describe('ALLOWED_COMMANDS', () => {
    it('should be a Set containing expected base commands', () => {
      expect(ALLOWED_COMMANDS).toBeInstanceOf(Set)
      expect(ALLOWED_COMMANDS.has('npm')).toBe(true)
      expect(ALLOWED_COMMANDS.has('git')).toBe(true)
      expect(ALLOWED_COMMANDS.has('node')).toBe(true)
      expect(ALLOWED_COMMANDS.has('docker')).toBe(true)
      expect(ALLOWED_COMMANDS.has('pm2')).toBe(true)
    })

    it('should not contain dangerous commands', () => {
      expect(ALLOWED_COMMANDS.has('rm')).toBe(false)
      expect(ALLOWED_COMMANDS.has('sudo')).toBe(false)
      expect(ALLOWED_COMMANDS.has('chmod')).toBe(false)
      expect(ALLOWED_COMMANDS.has('chown')).toBe(false)
      expect(ALLOWED_COMMANDS.has('kill')).toBe(false)
    })
  })

  describe('ALLOWED_COMMANDS_SORTED', () => {
    it('should be a sorted array', () => {
      const sorted = [...ALLOWED_COMMANDS_SORTED].sort()
      expect(ALLOWED_COMMANDS_SORTED).toEqual(sorted)
    })

    it('should contain same entries as the Set', () => {
      expect(ALLOWED_COMMANDS_SORTED.length).toBe(ALLOWED_COMMANDS.size)
      for (const cmd of ALLOWED_COMMANDS_SORTED) {
        expect(ALLOWED_COMMANDS.has(cmd)).toBe(true)
      }
    })
  })

  describe('DANGEROUS_SHELL_CHARS', () => {
    it.each([
      ['pipe', 'ls | grep foo'],
      ['semicolons', 'ls; rm -rf /'],
      ['ampersands', 'cmd && cmd2'],
      ['backticks', 'echo `whoami`'],
      ['dollar signs', 'echo $PATH'],
      ['parentheses', '$(command)'],
      ['redirect >', 'echo foo > file'],
      ['redirect <', 'cat < file']
    ])('should match %s', (_label, input) => {
      expect(DANGEROUS_SHELL_CHARS.test(input)).toBe(true)
    })

    it.each([
      ['npm install express'],
      ['git commit -m "hello"']
    ])('should not match safe string: %s', (input) => {
      expect(DANGEROUS_SHELL_CHARS.test(input)).toBe(false)
    })
  })

  describe('validateCommand', () => {
    it('should accept a valid simple command', () => {
      const result = validateCommand('npm install')
      expect(result).toEqual({
        valid: true,
        baseCommand: 'npm',
        args: ['install']
      })
    })

    it('should accept commands with multiple args', () => {
      const result = validateCommand('git commit -m "test message"')
      expect(result).toEqual({
        valid: true,
        baseCommand: 'git',
        args: ['commit', '-m', 'test message']
      })
    })

    it('should accept commands with single-quoted args', () => {
      const result = validateCommand("git log --format='%H %s'")
      expect(result).toEqual({
        valid: true,
        baseCommand: 'git',
        args: ['log', "--format=%H %s"]
      })
    })

    it('should accept a bare allowed command', () => {
      const result = validateCommand('pwd')
      expect(result).toEqual({
        valid: true,
        baseCommand: 'pwd',
        args: []
      })
    })

    it.each([
      ['null', null, 'Command is required'],
      ['undefined', undefined, 'Command is required'],
      ['empty string', '', 'Command is required'],
      ['non-string (number)', 123, 'Command is required'],
      ['whitespace-only', '   ', 'Command cannot be empty']
    ])('should reject %s input', (_label, input, expectedError) => {
      const result = validateCommand(input)
      expect(result.valid).toBe(false)
      expect(result.error).toBe(expectedError)
    })

    it('should reject commands with pipe operator', () => {
      const result = validateCommand('npm list | grep express')
      expect(result.valid).toBe(false)
      expect(result.error).toBe('Command contains disallowed shell characters')
    })

    it('should reject commands with semicolons', () => {
      const result = validateCommand('npm test; rm -rf /')
      expect(result.valid).toBe(false)
      expect(result.error).toBe('Command contains disallowed shell characters')
    })

    it('should reject commands with command substitution', () => {
      const result = validateCommand('npm install $(cat packages.txt)')
      expect(result.valid).toBe(false)
      expect(result.error).toBe('Command contains disallowed shell characters')
    })

    it('should reject commands not in allowlist', () => {
      const result = validateCommand('rm -rf /')
      expect(result.valid).toBe(false)
      expect(result.error).toContain("Command 'rm' is not in the allowlist")
      expect(result.error).toContain('Allowed:')
    })

    it('should reject unknown commands', () => {
      const result = validateCommand('malware execute')
      expect(result.valid).toBe(false)
      expect(result.error).toContain("Command 'malware' is not in the allowlist")
    })

    it('should handle leading/trailing whitespace', () => {
      const result = validateCommand('  npm install  ')
      expect(result.valid).toBe(true)
      expect(result.baseCommand).toBe('npm')
    })

    it('should handle empty quoted strings in args', () => {
      const result = validateCommand('git commit -m ""')
      expect(result.valid).toBe(true)
      expect(result.args).toContain('')
    })
  })

  describe('redactOutput', () => {
    it.each([
      ['SECRET_KEY', '{"SECRET_KEY": "my-secret-123", "name": "test"}', '{"SECRET_KEY": "[REDACTED]", "name": "test"}'],
      ['TOKEN', '{"API_TOKEN": "abc123"}', '{"API_TOKEN": "[REDACTED]"}'],
      ['PASSWORD', '{"DB_PASSWORD": "hunter2"}', '{"DB_PASSWORD": "[REDACTED]"}'],
      ['AUTH', '{"GITHUB_AUTH": "ghp_abc123"}', '{"GITHUB_AUTH": "[REDACTED]"}'],
      ['CREDENTIAL', '{"SERVICE_CREDENTIAL": "cred-xyz"}', '{"SERVICE_CREDENTIAL": "[REDACTED]"}']
    ])('should redact %s values', (_label, input, expected) => {
      expect(redactOutput(input)).toBe(expected)
    })

    it('should not redact non-sensitive keys', () => {
      const input = '{"name": "test", "port": "3000"}'
      const result = redactOutput(input)
      expect(result).toBe(input)
    })

    it('should handle null input', () => {
      expect(redactOutput(null)).toBe(null)
    })

    it('should handle undefined input', () => {
      expect(redactOutput(undefined)).toBe(undefined)
    })

    it('should handle empty string', () => {
      expect(redactOutput('')).toBe('')
    })

    it('should handle plain text without JSON', () => {
      const input = 'Server started on port 3000'
      expect(redactOutput(input)).toBe(input)
    })

    it('should redact multiple sensitive values', () => {
      const input = '{"API_KEY": "key1", "SECRET_TOKEN": "tok2", "name": "app"}'
      const result = redactOutput(input)
      expect(result).toContain('"API_KEY": "[REDACTED]"')
      expect(result).toContain('"SECRET_TOKEN": "[REDACTED]"')
      expect(result).toContain('"name": "app"')
    })
  })
})
