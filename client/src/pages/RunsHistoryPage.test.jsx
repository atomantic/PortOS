import { describe, it, expect, vi } from 'vitest';

// RunsHistoryPage pulls in the API barrel transitively; stub it so importing the
// module for the pure-helper test doesn't drag real HTTP wrappers into scope.
vi.mock('../services/api', () => ({}));

import { runLogProcessName } from './RunsHistoryPage';

describe('runLogProcessName', () => {
  it('maps cos-agent runs to the portos-cos process', () => {
    expect(runLogProcessName('cos-agent')).toBe('portos-cos');
  });

  it('maps devtools and unknown sources to the main portos-server process', () => {
    expect(runLogProcessName('devtools')).toBe('portos-server');
    expect(runLogProcessName(undefined)).toBe('portos-server');
  });
});
