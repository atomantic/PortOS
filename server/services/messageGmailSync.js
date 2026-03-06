/**
 * Sync Gmail messages via MCP
 * This is a stub that returns an empty array until Gmail MCP is configured.
 * When MCP is available, this will call the Gmail API through the MCP bridge.
 */
export async function syncGmail(account, cache, io) {
  console.log(`📧 Gmail sync for ${account.email} — MCP integration pending`);
  io?.emit('messages:sync:progress', { accountId: account.id, current: 0, total: 0 });
  // TODO: Integrate with Gmail MCP when available
  // The MCP bridge would call gmail.users.messages.list and gmail.users.messages.get
  return { messages: [], status: 'not-configured' };
}

/**
 * Send email via Gmail MCP
 */
export async function sendGmail(account, draft) {
  console.log(`📧 Gmail send for ${account.email} — MCP integration pending`);
  // TODO: Integrate with Gmail MCP when available
  return { success: false, error: 'Gmail MCP not configured', status: 501, code: 'GMAIL_MCP_NOT_CONFIGURED' };
}
