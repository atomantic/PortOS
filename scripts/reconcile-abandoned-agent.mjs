#!/usr/bin/env node
// Local operator tool. Does not kill work or declare an audit successful.
import { reconcileAbandonedAgent } from '../server/services/abandonedAgentRecovery.js';
const [agentId, runId, confirmation, ...reason] = process.argv.slice(2);
try {
  if (confirmation !== '--confirm-abandoned') throw new Error('Usage: node scripts/reconcile-abandoned-agent.mjs <agent-id> <run-id> --confirm-abandoned <reason>');
  const receipt = await reconcileAbandonedAgent({ agentId, runId, confirmAbandoned: true, reason: reason.join(' ') });
  console.log(JSON.stringify({ disposition: receipt.disposition, agentId: receipt.agentId, runId: receipt.runId, replayed: receipt.replayed ?? false }));
} catch (error) { console.error(`❌ ${error.message}`); process.exitCode = 1; }
