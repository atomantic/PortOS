import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/execGit.js', () => ({ execGit: vi.fn(), execGitSafe: vi.fn() }));
import { execGit } from '../lib/execGit.js';
import { generatePRDescription } from './git.js';
import { initialSecurityScanEvidence } from '../lib/securityScanEvidence.js';
import { SENTINEL_COMPLETION_MARKER } from '../lib/agentOutputMarkers.js';

const report = [
  '## Summary',
  '',
  'Fixed draft descriptions to retain only the final implementation report.',
  '',
  '## Validation',
  '- Focused regression checks passed.',
  '+ Compatibility with existing Markdown is preserved.',
  '',
  '```js',
  '$ npm test',
  'diff --git a/example.js b/example.js',
  '+const example = "synthetic";',
  '```'
].join('\n');
const body = `Automated PR created by PortOS Chief of Staff.\n\n${report}`;
const diff = [
  '$ git diff',
  'diff --git a/example.js b/example.js',
  'index aabbcc..ddeeff 100644',
  '--- a/example.js',
  '+++ b/example.js',
  '@@ -1,2 +1,3 @@',
  ' const existing = true;',
  '-const old = true;',
  '+const fixed = true;',
  '+console.log("tool output must stay out");'
].join('\n');

beforeEach(() => {
  vi.clearAllMocks();
  execGit.mockImplementation(async args => ({ stdout: args[0] === 'log'
    ? JSON.stringify({ hash: 'abc1234', message: 'fix: improve draft descriptions' })
    : '1 file changed, 1 insertion(+)', stderr: '', exitCode: 0 }));
});

const generate = output => generatePRDescription('/synthetic/repo', 'main', 'feature', output);

describe('generatePRDescription', () => {
  const scan = { ...initialSecurityScanEvidence({ model: 'example-model', effort: 'medium', auth: 'chatgpt', maxCostUsd: 'unlimited', timeLimitSeconds: 'unlimited' }),
    status: 'failed', exitCode: 2, sequence: 3, estimatedCostUsd: 0, artifacts: { findings: true, coverage: null }, cleanup: 'confirmed',
    baseline: { kind: 'git-commit', commit: 'a'.repeat(40), tree: 'b'.repeat(40), uncommitted: 'excluded', submodules: 'excluded', symlinks: 'link-text' } };

  it('preserves bounded runner evidence before a truncated final report and separates delivery from coverage', async () => {
    const output = SENTINEL_COMPLETION_MARKER + '\n' + `## Summary\n${'Synthetic completed audit.\n'.repeat(200)}`.slice(0, 4096) + '\n…[truncated]';
    const body = await generatePRDescription('/synthetic/repo', 'main', 'feature', output, scan);
    expect(body.indexOf('Security scanner (runner observed)')).toBeLessThan(body.indexOf('## Summary'));
    expect(body).toContain('Status: **failed**');
    expect(body).toContain('Audit delivery and assessment success are separate');
    expect(body).toContain('estimated USD: 0; estimate cap: none; time limit (seconds): none');
    expect(body).toContain('Exit: 2; process cleanup: confirmed; findings artifact: saved; coverage artifact: unknown');
    expect(body).toContain(`Baseline commit: \`${'a'.repeat(40)}\``);
    expect(body).toContain('does not certify subsequent repairs');
    expect(body.length).toBeLessThan(6000);
  });

  it.each([{ ...scan, source: 'agent-report' }, { ...scan, prompt: 'private injected field' }])('does not publish untrusted or malformed metadata as runner evidence', async evidence => {
    const body = await generatePRDescription('/synthetic/repo', 'main', 'feature', report, evidence);
    expect(body).toContain('Runner evidence unavailable');
    expect(body).not.toContain('Status: **failed**');
    expect(body).not.toContain('private injected field');
  });

  it('preserves unknown legacy scope and a connection interruption independently of the last runner observation', async () => {
    const { baseline: _baseline, ...legacy } = scan;
    const body = await generatePRDescription('/synthetic/repo', 'main', 'feature', '', { ...legacy, status: 'running', exitCode: null }, { status: 'interrupted', cleanup: 'unconfirmed' });
    expect(body).toContain('Status: **running**');
    expect(body).toContain('Runner connection lost: interrupted; process cleanup unconfirmed');
    expect(body).toContain('Scanned revision: unknown');
  });

  it('keeps the report after raw diff output and token accounting, including Markdown', async () => {
    expect(await generate(`${diff}\ntokens used\n1,234\n\n${report}`)).toBe(body);
    expect(execGit).not.toHaveBeenCalled();
  });

  it('recognizes a final report after token accounting when the tail starts inside a diff', async () => {
    const output = `${'+    const unchanged = true;\n'.repeat(180)}tokens used\n1,234\n${report}`;
    expect(await generate(output)).toBe(body);
  });

  it('drops CLI command accounting headers and unified diff context before the final report', async () => {
    const output = [
      'Chunk ID: synthetic',
      'Wall time: 0.02 seconds',
      'Process exited with code 0',
      'Original token count: 123',
      'Output:',
      diff,
      '',
      'tokens used',
      '1234',
      report
    ].join('\n');
    expect(await generate(output)).toBe(body);
  });

  it.each([
    `${diff}\ncodex\n${report}\ntokens used: 1234`,
    `${diff}\ncodex\ntokens used\n1234\n${report}`
  ])('supports both Codex final-reply/footer orders', async output => {
    expect(await generate(output)).toBe(body);
  });

  it('prefers an explicitly final assistant response over command records and commentary', async () => {
    const output = [
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Investigating the implementation before making changes.' }] } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: report }] } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', aggregated_output: diff } })
    ].join('\n');
    expect(await generate(output)).toBe(body);
  });

  it('uses a successful structured CLI result', async () => {
    const output = [diff, JSON.stringify({ type: 'result', subtype: 'success', result: report, is_error: false })].join('\n');
    expect(await generate(output)).toBe(body);
  });

  it('removes a trailing token footer without discarding a plain Markdown report', async () => {
    expect(await generate(`${report}\ntokens used\n1234`)).toBe(body);
  });

  it.each([null, diff, 'exec\nsynthetic command succeeded in 20ms:\nOutput:\nA long raw command result with no assistant report.\nOriginal token count: 123', `${diff}\ntokens used\n1234`, JSON.stringify({ type: 'result', subtype: 'success', result: '' }), JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'This error is not an implementation report.' })])(
    'falls back to commits when no usable report remains', async output => {
      expect(await generate(output)).toBe('Automated PR created by PortOS Chief of Staff.\n\n## Changes\n\n- fix: improve draft descriptions');
      expect(execGit).toHaveBeenCalledWith(['log', expect.any(String), 'main..feature'], '/synthetic/repo', { ignoreExitCode: true });
    }
  );
});
