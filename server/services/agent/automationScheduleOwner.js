/** Validates that a schedule's agent exists and owns its platform account. */

import { ServerError } from '../../lib/errorHandler.js';
import { getAccountById } from '../platformAccounts.js';
import { getAgentById } from './agentPersonalities.js';

export async function validateScheduleOwner({ agentId, accountId }) {
  const agent = await getAgentById(agentId);
  if (!agent) {
    throw new ServerError('Agent not found', { status: 404, code: 'AGENT_NOT_FOUND' });
  }

  const account = await getAccountById(accountId);
  if (!account) {
    throw new ServerError('Account not found', { status: 404, code: 'ACCOUNT_NOT_FOUND' });
  }
  if (account.agentId !== agentId) {
    throw new ServerError('Account does not belong to this agent', {
      status: 400,
      code: 'ACCOUNT_AGENT_MISMATCH'
    });
  }
}
