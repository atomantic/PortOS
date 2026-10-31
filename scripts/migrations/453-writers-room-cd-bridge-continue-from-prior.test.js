import { describe, expect, it } from 'vitest';

import { runPromptMigrationTests, sampleBody } from './_testHelpers.js';
import migration, {
  ACCEPTED_OLD_MD5,
  NEW_SHIPPED_MD5,
  applyMigration,
} from './453-writers-room-cd-bridge-continue-from-prior.js';
import { shapeProposal } from '../../server/services/writersRoom/liveDirector.js';

describe('migration 453 — CD-bridge continueFromPrior prompt', () => {
  runPromptMigrationTests({
    migration,
    applyMigration,
    ACCEPTED_OLD_MD5,
    NEW_SHIPPED_MD5,
    prefix: 'migration-453-cd-bridge-continue-from-prior-',
  });

  it('asks for continueFromPrior only on genuinely continuous shots, and shows it in the contract', () => {
    const body = sampleBody('writers-room-cd-bridge.md');
    expect(body).toContain('`continueFromPrior` (optional)');
    expect(body).toContain('ONLY when');
    expect(body).toContain('"continueFromPrior": false');
  });

  it('the shaped proposal keeps the flag a model emits per the prompt contract', () => {
    const proposal = shapeProposal({
      logline: 'l',
      synopsis: 's',
      scenes: [
        { intent: 'a', prompt: 'Wide', durationSeconds: 5, continueFromPrior: false },
        { intent: 'b', prompt: 'Push in', durationSeconds: 5, continueFromPrior: true },
      ],
    });
    expect(proposal.scenes.map((s) => s.continueFromPrior)).toEqual([undefined, true]);
  });
});
