import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { PATHS } from '../server/lib/paths.js';

const execFileAsync = promisify(execFile);

describe('scripts/measure-agent-prompt.js', () => {
  it('renders split user and system prompts for claim-issue tui offline without mutating task-schedule.json', async () => {
    const schedulePath = join(PATHS.cos, 'task-schedule.json');
    const existedBefore = existsSync(schedulePath);
    const mtimeBefore = existedBefore ? statSync(schedulePath).mtimeMs : null;

    const { stdout } = await execFileAsync(
      process.execPath,
      [join(PATHS.installRoot, 'scripts', 'measure-agent-prompt.js'), 'claim-issue', 'tui'],
      { cwd: PATHS.installRoot, timeout: 15000 },
    );

    expect(stdout).toContain('claim-issue via tui:');
    expect(stdout).toContain('--- user prompt (');
    expect(stdout).toContain('--- system prompt (');

    if (existedBefore) {
      expect(statSync(schedulePath).mtimeMs).toBe(mtimeBefore);
    } else {
      expect(existsSync(schedulePath)).toBe(false);
    }
  });
});
