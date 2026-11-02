import { describe, expect, it, vi } from 'vitest';
import { isSupervisorOnly } from './harnessProcessGroup.js';

describe('supervisor group inspection', () => {
  it('accepts only a complete result containing the original supervisor alone', async () => {
    const run = vi.fn().mockResolvedValueOnce('123\n').mockResolvedValueOnce('123\n456\n')
      .mockResolvedValueOnce(null).mockResolvedValueOnce('123\ninvalid');
    expect(await isSupervisorOnly(123, { run })).toBe(true);
    expect(run).toHaveBeenCalledWith('/usr/bin/pgrep', ['-g', '123', '.'], expect.objectContaining({ timeoutMs: 3000 }));
    expect(await isSupervisorOnly(123, { run })).toBe(false);
    expect(await isSupervisorOnly(123, { run })).toBeNull();
    expect(await isSupervisorOnly(123, { run })).toBeNull();
    expect(await isSupervisorOnly(-1, { run })).toBeNull();
    expect(run).toHaveBeenCalledTimes(4);
  });
});
