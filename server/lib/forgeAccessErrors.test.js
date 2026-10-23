import { describe, it, expect } from 'vitest';
import {
  parseForgeMissingScopes,
  forgeMissingScopesOf,
  forgeScopeRefreshCommand,
  REFRESHABLE_FORGE_SCOPES,
} from './forgeAccessErrors.js';

describe('parseForgeMissingScopes', () => {
  it.each([
    ['GraphQL workflow refusal', 'GraphQL: refusing to allow an OAuth App to create or update workflow `.github/workflows/admin.yml` without `workflow` scope (mergePullRequest)', ['workflow']],
    ['REST needs-the-scope', 'This API operation needs the "gist" scope. (HTTP 404)', ['gist']],
    ['gh preflight list', 'error: your authentication token is missing required scopes [workflow, read:org]', ['workflow', 'read:org']],
    ['GraphQL one-of list', "The 'id' field requires one of the following scopes: ['read:org'], but your token has only been granted the: ['repo']", ['read:org']],
  ])('reads %s', (_label, text, scopes) => {
    expect(parseForgeMissingScopes(text)).toEqual(scopes);
  });

  // A permission grant on an App token is not a scope; refreshing cannot fix it.
  it.each([
    'Resource not accessible by integration',
    'Could not resolve to a Repository with the name acme/widget',
    'Head commit changed',
    '',
    null,
  ])('ignores %j', (text) => {
    expect(parseForgeMissingScopes(text)).toEqual([]);
  });

  it('drops a captured name that is not a plausible scope', () => {
    expect(parseForgeMissingScopes('missing required scopes [workflow; rm -rf /]')).toEqual([]);
  });
});

describe('forgeMissingScopesOf', () => {
  it('prefers the stamp execGh set and falls back to the message', () => {
    expect(forgeMissingScopesOf({ ghMissingScopes: ['workflow'], message: 'x' })).toEqual(['workflow']);
    expect(forgeMissingScopesOf(new Error('needs the "gist" scope'))).toEqual(['gist']);
    expect(forgeMissingScopesOf(new Error('boom'))).toEqual([]);
  });
});

describe('forgeScopeRefreshCommand', () => {
  it('names the host and joins the scopes', () => {
    expect(forgeScopeRefreshCommand('ghe.example.com', ['workflow', 'gist'])).toBe('gh auth refresh -h ghe.example.com -s workflow,gist');
  });

  it('never offers an admin-level scope for one-click refresh', () => {
    expect(REFRESHABLE_FORGE_SCOPES.filter((scope) => scope.startsWith('admin:') || scope === 'delete_repo')).toEqual([]);
  });
});
