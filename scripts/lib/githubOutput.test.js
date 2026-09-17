import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  formatErrorAnnotation, writeStepEnv, writeStepOutput, writeStepSummary,
} from './githubOutput.js';

describe('writeStepOutput', () => {
  let outputPath;
  const previous = process.env.GITHUB_OUTPUT;

  beforeEach(() => {
    outputPath = join(mkdtempSync(join(tmpdir(), 'gh-output-')), 'output.txt');
    writeFileSync(outputPath, '');
    process.env.GITHUB_OUTPUT = outputPath;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = previous;
  });

  it('appends one name=value line per call', () => {
    writeStepOutput('verified', true);
    writeStepOutput('reason', 'identical tree');

    expect(readFileSync(outputPath, 'utf8')).toBe('verified=true\nreason=identical tree\n');
  });

  it('strips newlines so a value cannot forge a second output', () => {
    writeStepOutput('reason', 'first line\nverified=true');

    expect(readFileSync(outputPath, 'utf8')).toBe('reason=first line verified=true\n');
  });

  it('does nothing outside GitHub Actions', () => {
    delete process.env.GITHUB_OUTPUT;

    expect(() => writeStepOutput('verified', false)).not.toThrow();
    expect(readFileSync(outputPath, 'utf8')).toBe('');
  });
});

describe('writeStepEnv', () => {
  let envPath;
  const previous = process.env.GITHUB_ENV;

  beforeEach(() => {
    envPath = join(mkdtempSync(join(tmpdir(), 'gh-env-')), 'env.txt');
    writeFileSync(envPath, '');
    process.env.GITHUB_ENV = envPath;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.GITHUB_ENV;
    else process.env.GITHUB_ENV = previous;
  });

  it('appends one name=value line per call', () => {
    writeStepEnv('CI_BASE_SHA', 'abc123');

    expect(readFileSync(envPath, 'utf8')).toBe('CI_BASE_SHA=abc123\n');
  });

  it('strips newlines so a value cannot forge a second variable', () => {
    writeStepEnv('CI_BASE_SHA', 'abc123\nPATH=/evil');

    expect(readFileSync(envPath, 'utf8')).toBe('CI_BASE_SHA=abc123 PATH=/evil\n');
  });

  it('writes to GITHUB_ENV, not GITHUB_OUTPUT', () => {
    const outputPath = join(mkdtempSync(join(tmpdir(), 'gh-output-')), 'output.txt');
    writeFileSync(outputPath, '');
    const previousOutput = process.env.GITHUB_OUTPUT;
    process.env.GITHUB_OUTPUT = outputPath;

    writeStepEnv('CI_BASE_SHA', 'abc123');

    if (previousOutput === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = previousOutput;
    expect(readFileSync(outputPath, 'utf8')).toBe('');
    expect(readFileSync(envPath, 'utf8')).toBe('CI_BASE_SHA=abc123\n');
  });

  it('does nothing outside GitHub Actions', () => {
    delete process.env.GITHUB_ENV;

    expect(() => writeStepEnv('CI_BASE_SHA', 'abc123')).not.toThrow();
    expect(readFileSync(envPath, 'utf8')).toBe('');
  });
});

describe('writeStepSummary', () => {
  let summaryPath;

  beforeEach(() => {
    summaryPath = join(mkdtempSync(join(tmpdir(), 'gh-summary-')), 'summary.md');
    writeFileSync(summaryPath, '');
  });

  it('appends the markdown block verbatim, newlines and all', () => {
    // The key/value writers collapse newlines because a newline forges a second
    // entry there. In markdown a newline is content, and collapsing it would
    // run a multi-line verdict into one unreadable line.
    writeStepSummary('### Verdict\n\n- one\n- two', { GITHUB_STEP_SUMMARY: summaryPath });

    expect(readFileSync(summaryPath, 'utf8')).toBe('### Verdict\n\n- one\n- two\n');
  });

  it('does nothing outside GitHub Actions', () => {
    expect(() => writeStepSummary('### Verdict', {})).not.toThrow();
    expect(readFileSync(summaryPath, 'utf8')).toBe('');
  });
});

describe('formatErrorAnnotation', () => {
  it('escapes the title and the message by their different rules', () => {
    // A `:` or `,` in a PROPERTY ends it, so both must be encoded there — and
    // must NOT be in the message, where they are ordinary punctuation.
    expect(formatErrorAnnotation('CI failed: server (1/2)', 'Run tests, then build'))
      .toBe('::error title=CI failed%3A server (1/2)::Run tests, then build');
  });

  it('encodes a newline rather than letting it end the annotation early', () => {
    expect(formatErrorAnnotation('t', 'line one\nline two')).toBe('::error title=t::line one%0Aline two');
    // `%` first, or the escapes above would be re-escaped into nonsense.
    expect(formatErrorAnnotation('t', '50% slower')).toBe('::error title=t::50%25 slower');
  });
});
