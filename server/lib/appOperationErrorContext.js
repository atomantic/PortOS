/** Bounded repair guidance only; arbitrary provider/error context stays server-side. */
export const appOperationErrorContext = (error) => {
  const context = error?.context;
  if (error?.code !== 'FORGE_TOKEN_SCOPE_MISSING' || !context
    || typeof context.host !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,252}$/i.test(context.host)
    || !Array.isArray(context.scopes) || context.scopes.length === 0 || context.scopes.length > 16
    || !context.scopes.every(scope => typeof scope === 'string' && /^[a-z0-9:_-]{1,64}$/i.test(scope))
    || (context.command != null && (typeof context.command !== 'string' || context.command.length > 1024))) return null;
  return {
    host: context.host,
    scopes: [...context.scopes],
    command: context.command ?? null,
    ...(context.credential === 'oauth' || context.credential === 'personal-access-token' ? { credential: context.credential } : {}),
    refreshable: context.refreshable === true,
  };
};
