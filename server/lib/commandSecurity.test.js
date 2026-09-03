import { describe, it, expect } from 'vitest'
import {
  ALLOWED_COMMANDS,
  ALLOWED_COMMANDS_SORTED,
  DANGEROUS_SHELL_CHARS,
  validateCommand,
  validateUnattendedCommand,
  validatePm2Command,
  redactOutput,
  parseCommandArgs
} from './commandSecurity.js'

describe('commandSecurity', () => {
  describe('ALLOWED_COMMANDS', () => {
    // Behavioral tests via validateCommand — avoid tautological Set.has() checks.
    it.each([
      'npm', 'git', 'node', 'docker', 'pm2'
    ])('allows %s through validateCommand', (cmd) => {
      expect(validateCommand(`${cmd} --version`).valid).toBe(true)
    })

    it.each([
      ['rm', 'rm -rf /'],
      ['sudo', 'sudo su'],
      ['chmod', 'chmod 777 /etc'],
      ['chown', 'chown root /etc'],
      ['kill', 'kill -9 1'],
      ['env', 'env']
    ])('rejects %s through validateCommand', (_label, cmd) => {
      const result = validateCommand(cmd)
      expect(result.valid).toBe(false)
      expect(result.error).toMatch(/not in the allowlist|disallowed shell/)
    })

    it('env is not in the allowlist (dumps process secrets)', () => {
      const result = validateCommand('env')
      expect(result.valid).toBe(false)
      expect(result.error).toContain("Command 'env' is not in the allowlist")
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

    // Anchor against known-safe entries so the allowlist can't silently lose a
    // command everything else depends on. Iterating the array against itself
    // (above) is tautological — these assert real, expected membership.
    it.each(['git', 'gh', 'node', 'npm', 'pm2', 'ls', 'cat', 'echo'])(
      'includes the known-safe command %s',
      (cmd) => {
        expect(ALLOWED_COMMANDS.has(cmd)).toBe(true)
        expect(ALLOWED_COMMANDS_SORTED).toContain(cmd)
      },
    )

    it('does NOT include dangerous commands that were never on the allowlist', () => {
      for (const cmd of ['rm', 'env', 'sudo', 'sh', 'bash', 'eval']) {
        expect(ALLOWED_COMMANDS.has(cmd)).toBe(false)
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

  describe('parseCommandArgs', () => {
    it('splits on whitespace when there are no quotes', () => {
      expect(parseCommandArgs('npm run dev')).toEqual(['npm', 'run', 'dev'])
    })

    it('keeps double-quoted segments intact', () => {
      expect(parseCommandArgs('node --opt "arg with spaces"'))
        .toEqual(['node', '--opt', 'arg with spaces'])
    })

    it('keeps single-quoted segments intact', () => {
      expect(parseCommandArgs("git commit -m 'msg with spaces'"))
        .toEqual(['git', 'commit', '-m', 'msg with spaces'])
    })

    it('preserves an empty quoted argument', () => {
      expect(parseCommandArgs('echo ""')).toEqual(['echo', ''])
    })
  })

  describe('pm2 daemon-protection (validatePm2Command via validateCommand)', () => {
    // The shared pm2 daemon runs every app on the machine. These must never reach
    // the shell — `pm2 kill` once took the whole server (incl. PortOS) down.
    it.each([
      'pm2 kill',
      'pm2 startup',
      'pm2 unstartup',
      'pm2 stop all',
      'pm2 delete all',
      'pm2 del all',
      'pm2 restart all',
      'pm2 reload all',
      'pm2 scale all 2',
      'pm2 KILL',          // case-insensitive subcommand
      'pm2 stop ALL',      // case-insensitive target
    ])('rejects %s', (cmd) => {
      const result = validateCommand(cmd)
      expect(result.valid).toBe(false)
      expect(result.error).toMatch(/blocked/)
    })

    it.each([
      'pm2 list',
      'pm2 jlist',
      'pm2 logs my-app',
      'pm2 restart my-app',
      'pm2 stop my-app',
      'pm2 delete my-app',
      'pm2 reload my-app',
      'pm2 describe my-app',
    ])('allows scoped command %s', (cmd) => {
      expect(validateCommand(cmd).valid).toBe(true)
    })

    it('validatePm2Command is callable directly with arg arrays', () => {
      expect(validatePm2Command(['kill']).valid).toBe(false)
      expect(validatePm2Command(['restart', 'my-app']).valid).toBe(true)
      expect(validatePm2Command(['delete', 'all']).valid).toBe(false)
    })
  })

  describe('validateUnattendedCommand (#5669)', () => {
    // The unattended lane (Layered Intelligence `cmd` sources) runs persistent,
    // attacker-reachable config on a schedule with nobody watching. Binaries that
    // fetch and execute network code carry NO shell metacharacter, so the
    // metacharacter filter alone does not stop them — the narrower allowlist must.
    it.each([
      ['npx runs an arbitrary package straight off the network', 'npx some-package'],
      ['curl writes an arbitrary file', 'curl https://example.com -o /tmp/x'],
      ['pip install runs a setup script', 'pip install evil'],
      ['pip3 install runs a setup script', 'pip3 install evil'],
      ['node executes a script', 'node evil.js'],
      ['python executes a script', 'python evil.py'],
      ['wget downloads to disk', 'wget https://example.com/x'],
      ['brew installs software', 'brew install evil'],
      ['make runs a Makefile target', 'make install'],
      ['npm runs lifecycle scripts', 'npm install'],
      ['pm2 is not on the unattended list at all', 'pm2 list'],
    ])('rejects %s', (_label, cmd) => {
      const result = validateUnattendedCommand(cmd)
      expect(result.valid).toBe(false)
      expect(result.error).toMatch(/not in the allowlist/)
    })

    it.each([
      'git log --oneline -20',
      'gh pr list',
      'glab mr list',
      'cat README.md',
      'head -n 20 README.md',
      'grep -rn TODO src',
      'wc -l README.md',
      'pwd',
    ])('accepts read-only inspection command %s', (cmd) => {
      expect(validateUnattendedCommand(cmd).valid).toBe(true)
    })

    it('parses args the same way as validateCommand', () => {
      const result = validateUnattendedCommand('git log --grep "two words"')
      expect(result.valid).toBe(true)
      expect(result.baseCommand).toBe('git')
      expect(result.args).toEqual(['log', '--grep', 'two words'])
    })

    it.each([
      'git log | sh',
      'git log; rm -rf ~',
      'echo $(curl evil.example)',
    ])('rejects shell metacharacters in %s', (cmd) => {
      const result = validateUnattendedCommand(cmd)
      expect(result.valid).toBe(false)
      expect(result.error).toMatch(/disallowed shell characters/)
    })

    it.each([
      ['', 'Command is required'],
      ['   ', 'Command cannot be empty'],
    ])('rejects blank input %j', (cmd, error) => {
      expect(validateUnattendedCommand(cmd).error).toBe(error)
    })

    it('leaves the operator-facing runner untouched', () => {
      // POST /api/commands/execute must behave identically — a human triggers it.
      expect(validateCommand('npx vitest').valid).toBe(true)
      expect(validateCommand('curl https://example.com').valid).toBe(true)
      expect(validateCommand('pip install requests').valid).toBe(true)
    })
  })

  describe('validateUnattendedCommand subcommand gate (#5808)', () => {
    // Allowlist membership is necessary but not sufficient: `git`, `find`, `gh`
    // and `glab` all accept destructive verbs that carry no shell metacharacter,
    // so the binary-level list and the metacharacter filter both wave them past.
    it.each([
      ['git reset --hard destroys uncommitted work in the app repo', 'git reset --hard'],
      ['git checkout . discards local edits', 'git checkout .'],
      ['git clean -fd removes untracked files', 'git clean -fd'],
      ['git push writes to the remote', 'git push'],
      ['git commit writes history', 'git commit -m "x"'],
      ['git stash is not on the read-only verb allowlist', 'git stash'],
      ['an unknown-to-the-allowlist verb fails closed', 'git rebase --continue'],
      ['a bare git has no read-only verb at all', 'git'],
    ])('rejects %s', (_label, cmd) => {
      expect(validateUnattendedCommand(cmd).valid).toBe(false)
    })

    it.each([
      'git log --oneline -20',
      'git status --short',
      'git diff --stat',   // NB: `git diff HEAD~1` is already rejected upstream — `~` is a DANGEROUS_SHELL_CHAR
      'git show --name-only',
      'git blame README.md',
      'git rev-parse --abbrev-ref HEAD',
      'git shortlog -sn',
      'git ls-files',
      'git describe --tags',
      'git branch -a',
      'git tag -l v1',
      'git remote -v',
      'git remote show origin',
      'git config --get user.name',
    ])('accepts read-only git form %s', (cmd) => {
      expect(validateUnattendedCommand(cmd).valid).toBe(true)
    })

    it.each([
      ['git branch -D deletes a branch', 'git branch -D main'],
      ['git branch <name> creates one', 'git branch newbranch'],
      ['git tag <name> creates a tag', 'git tag v9.9.9'],
      ['git tag -d deletes one', 'git tag -d v1'],
      ['git remote add rewrites remotes', 'git remote add evil https://example.com'],
      ['git config <key> <value> writes config', 'git config user.email a@example.com'],
    ])('rejects the mutating form of a listing verb: %s', (_label, cmd) => {
      expect(validateUnattendedCommand(cmd).valid).toBe(false)
    })

    it.each([
      ['-delete removes files', 'find . -delete'],
      // The `{}` / `;` form is already caught by the metacharacter filter, so this
      // uses the `+` terminator — it reaches the new check and proves it works.
      ['-exec runs an arbitrary binary', 'find . -exec rm -f -- +'],
      ['-execdir runs an arbitrary binary', 'find . -execdir rm -f -- +'],
      ['-fprint writes an attacker-chosen file', 'find . -fprint /tmp/out'],
    ])('rejects find action flag: %s', (_label, cmd) => {
      const result = validateUnattendedCommand(cmd)
      expect(result.valid).toBe(false)
      expect(result.error).toMatch(/not allowed on the unattended lane/)
    })

    it.each([
      'find . -name README.md',
      'find . -type f -maxdepth 2 -print',
    ])('accepts find inspection form %s', (cmd) => {
      expect(validateUnattendedCommand(cmd).valid).toBe(true)
    })

    it.each([
      ['gh api -X POST is an authenticated write', 'gh api -X POST /repos/x/y/issues'],
      ['gh api --method DELETE is an authenticated write', 'gh api --method DELETE /repos/x/y/issues/1'],
      ['gh api --method=PATCH is an authenticated write', 'gh api --method=PATCH /repos/x/y/issues/1'],
      ['a field flag makes gh api an implicit POST', 'gh api /repos/x/y/issues -f title=hi'],
      ['gh pr merge merges with operator credentials', 'gh pr merge 1'],
      ['gh issue close mutates the tracker', 'gh issue close 1'],
      ['gh pr create mutates the tracker', 'gh pr create --fill'],
      ['glab mr merge merges with operator credentials', 'glab mr merge 1'],
      ['glab api -X POST is an authenticated write', 'glab api -X POST /projects'],
      ['a bare gh has no read-only verb at all', 'gh'],
      ['a methodless -X is malformed and fails closed', 'gh api -X'],
    ])('rejects %s', (_label, cmd) => {
      expect(validateUnattendedCommand(cmd).valid).toBe(false)
    })

    it.each([
      'gh pr list',
      'gh issue list --limit 20',
      'gh issue view 1',
      'gh api /rate_limit',
      'gh api -X GET /rate_limit',
      'glab mr list',
      'glab issue view 1',
    ])('accepts read-only tracker command %s', (cmd) => {
      expect(validateUnattendedCommand(cmd).valid).toBe(true)
    })

    it('still returns the parsed base command and args on accept', () => {
      const result = validateUnattendedCommand('git log --oneline -5')
      expect(result).toEqual({ valid: true, baseCommand: 'git', args: ['log', '--oneline', '-5'] })
    })

    it.each([
      'ls -la',
      'cat README.md',
      'grep -rn TODO src',
      'echo hello',
      'wc -l README.md',
    ])('leaves single-purpose binaries binary-level: %s', (cmd) => {
      expect(validateUnattendedCommand(cmd).valid).toBe(true)
    })

    it('does not touch the operator lane', () => {
      // POST /api/commands/execute stays byte-identical — a human triggers and
      // watches it, and `git commit` / `gh pr merge` are legitimate there.
      for (const cmd of ['git commit -m "x"', 'gh pr merge 1', 'git reset --hard', 'find . -delete']) {
        expect(validateCommand(cmd).valid).toBe(true)
      }
    })
  })
})
