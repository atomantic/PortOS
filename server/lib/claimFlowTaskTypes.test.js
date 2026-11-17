import { describe, it, expect } from 'vitest';

import { CLAIM_FLOW_TASK_TYPES } from './claimFlowTaskTypes.js';
import { isClaimFlowTask } from '../services/agentPromptBuilder.js';

describe('the shared set drives the read side', () => {
  it('lists the claim-owned task kinds', () => {
    expect([...CLAIM_FLOW_TASK_TYPES].sort()).toEqual(
      ['claim-issue', 'claim-issue-gitlab', 'claim-issue-jira', 'claim-work', 'plan-task']
    );
  });

  it('treats every member as a claim-flow run via its legacy analysisType', () => {
    for (const analysisType of CLAIM_FLOW_TASK_TYPES) {
      expect(isClaimFlowTask({ metadata: { analysisType } })).toBe(true);
    }
    expect(isClaimFlowTask({ metadata: { analysisType: 'ux' } })).toBe(false);
  });
});
