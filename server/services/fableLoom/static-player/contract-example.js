// Host-owned example. index.html does not load this file.
// Assign it before the page module runs:
// globalThis.FableLoomPlayer = { resolveTurn: globalThis.FableLoomHostResolverExample };
globalThis.FableLoomHostResolverExample = async function resolveTurn(nodeId, message) {
  const response = await globalThis.fetch('/story/turn', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nodeId, message }),
  });
  if (!response.ok) return { stay: 'The host did not answer.' };
  const body = await response.json();
  if (body && body.action === 'move' && typeof body.transitionId === 'string') {
    return { move: body.transitionId };
  }
  const narration = body && typeof body.narration === 'string' ? body.narration : '';
  return { stay: narration };
};
