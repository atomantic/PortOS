/**
 * Parity guard between `createCosTaskSchema` (lib/cosValidation.js) and
 * `buildTaskMetadata` — see the module header in cosTaskIntake.js for why.
 * Every schema field is either mapped (a schema-valid sample must change the
 * metadata) or named as non-metadata with the reason; anything else fails.
 */

import { describe, it, expect } from 'vitest';
import { createCosTaskSchema } from '../lib/cosValidation.js';
import { REVIEW_STOP_MODES } from '../lib/reviewerConfig.js';
import { PR_COMPLETIONS } from '../lib/prDisposition.js';
import { buildTaskMetadata } from './cosTaskIntake.js';

const NOW = Date.UTC(2026, 0, 2, 3, 4, 5);
const base = () => buildTaskMetadata({ description: 'x' }, 'user', { now: NOW });

// Request fields consumed by the route or the store itself, never carried
// into `metadata`. Naming them is the verdict; the parity test below refuses
// a schema field that is neither here nor sampled.
const NON_METADATA_FIELDS = {
  description: 'the task headline (a multi-line body becomes metadata.prompt in the store)',
  priority: 'top-level task field',
  type: 'selects the user vs internal task file',
  approvalRequired: 'top-level approval flags',
  position: 'queue placement',
  issueTarget: 'resolved by the route into the plan-task prompt',
};

// One schema-valid value per metadata-bound field. Each must change the
// persisted metadata relative to a bare request — that is the whole check.
const METADATA_SAMPLES = {
  diagnostics: { category: 'lint', tier: 1 },
  context: 'one-line note',
  prompt: 'full agent-facing prompt',
  model: 'example-model',
  provider: 'example-provider',
  effort: 'high',
  orchestrationMode: 'orchestrated',
  orchestrationProfile: { architect: { provider: 'example-provider', model: 'example-model' } },
  temperature: 0.4,
  thinking: true,
  app: 'Example App',
  targetInstanceId: 'inst-example',
  screenshots: ['shot.png'],
  attachments: [{ filename: 'a.txt', path: 'uploads/a.txt' }],
  createJiraTicket: true,
  jiraTicketId: 'EX-1',
  jiraTicketUrl: 'https://example.com/browse/EX-1',
  useWorktree: true,
  isInvestigation: true,
  whenDone: 'commit-push',
  planOnly: true,
  openPR: true,
  prCompletion: PR_COMPLETIONS.LEAVE_OPEN,
  simplify: true,
  worktreeChangesExpected: false,
  reviewLoop: true,
  reviewer: 'codex',
  reviewers: ['codex', 'claude'],
  reviewStopMode: REVIEW_STOP_MODES[1],
  reviewerApplies: true,
  usernames: ['alice'],
  optionalReviewers: ['codex'],
  reviewerMaxRounds: { codex: 2 },
  reviewerModels: { codex: 'example-model' },
  reviewerEfforts: { codex: 'high' },
  slashdoCommand: 'review',
  slashdoArgs: '--all',
};

describe('createCosTaskSchema ↔ buildTaskMetadata parity', () => {
  it('classifies every schema field exactly once', () => {
    const schemaFields = Object.keys(createCosTaskSchema.shape).sort();
    const classified = [...Object.keys(NON_METADATA_FIELDS), ...Object.keys(METADATA_SAMPLES)].sort();
    expect(classified).toEqual(schemaFields);
  });

  it.each(Object.entries(METADATA_SAMPLES))('carries %s onto metadata', (field, value) => {
    // Run the sample through the schema first, as the route does, so a sample
    // the schema would reject cannot pass the mapping check vacuously.
    const parsed = createCosTaskSchema.parse({ description: 'x', [field]: value });
    expect(buildTaskMetadata(parsed, 'user', { now: NOW })).not.toEqual(base());
  });

  // Bypass probe: the check above only means something if an unmapped field
  // really does leave metadata untouched.
  it('leaves metadata untouched for a field the intake does not map', () => {
    expect(buildTaskMetadata({ description: 'x', notARequestField: true }, 'user', { now: NOW })).toEqual(base());
  });
});
