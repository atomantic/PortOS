import { describe, it, expect, vi, beforeEach } from 'vitest';
import { commandOutput } from './commandExists.js';
import { probeGrokModelCatalog } from './grokModelCatalog.js';

vi.mock('./commandExists.js', () => ({ commandOutput: vi.fn() }));

const LISTING = `Logged in with example.com
Default model: grok-4.7-build-fast

Available models:
  * grok-4.7
  * grok-4.7-build-fast (default)
  - grok-4.6
`;

describe('probeGrokModelCatalog', () => {
  beforeEach(() => { commandOutput.mockReset(); });

  it('keeps bullet ids and the default-model line, and drops the banner', async () => {
    commandOutput.mockResolvedValue(LISTING);
    await expect(probeGrokModelCatalog({ command: 'grok' })).resolves.toEqual({
      ids: ['grok-4.7', 'grok-4.7-build-fast', 'grok-4.6'],
      defaultModel: 'grok-4.7-build-fast',
    });
  });

  it('returns an empty catalog when the command runs but prints no models', async () => {
    commandOutput.mockResolvedValue('not logged in');
    await expect(probeGrokModelCatalog({ command: 'grok' })).resolves.toEqual({ ids: [], defaultModel: null });
  });

  it('returns null when the models command does not run', async () => {
    commandOutput.mockResolvedValue(null);
    await expect(probeGrokModelCatalog({ command: '/opt/grok', envVars: { EXAMPLE: '1' } }, { cwd: '/work', timeoutMs: 4000 })).resolves.toBeNull();
    expect(commandOutput).toHaveBeenCalledWith('/opt/grok', ['models'], expect.objectContaining({
      timeoutMs: 4000, cwd: '/work', env: expect.objectContaining({ EXAMPLE: '1' }),
    }));
  });
});
