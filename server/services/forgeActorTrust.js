/**
 * Repository authority comes from authenticated forge metadata, never from a
 * comment, label, display name or authorAssociation. Cache only within one
 * gather pass so removed collaborators lose authority on the next poll.
 */
import { safeJSONParse } from '../lib/fileUtils.js';

const loginKey = (value) => typeof value === 'string'
  && /^[a-z0-9][a-z0-9_-]*(?:\[bot\])?$/i.test(value) ? value.toLowerCase() : null;
const WRITE_PERMISSIONS = new Set(['write', 'push', 'maintain', 'admin']);

export async function createGithubActorTrust({ runGh, host, repoFullName, currentUser } = {}) {
  const validTarget = typeof runGh === 'function' && typeof host === 'string'
    && /^[a-z0-9.-]+$/i.test(host) && typeof repoFullName === 'string'
    && /^[a-z0-9_-]+\/[a-z0-9_.-]+$/i.test(repoFullName);
  if (!validTarget) return { currentUser: null, isTrusted: async () => false };

  const read = async (endpoint) => {
    const raw = await runGh(['api', '--hostname', host, '--method', 'GET', endpoint]).catch(() => null);
    return safeJSONParse(raw, null, { logError: false });
  };
  const viewer = currentUser === undefined ? (await read('user'))?.login : currentUser;
  const self = loginKey(viewer);
  const owner = loginKey(repoFullName.split('/')[0]);
  const permissions = new Map();
  return {
    currentUser: self,
    async isTrusted(login) {
      const actor = loginKey(login);
      if (!actor) return false;
      if (actor === self || actor === owner) return true;
      if (!permissions.has(actor)) {
        permissions.set(actor, read(`repos/${repoFullName}/collaborators/${encodeURIComponent(actor)}/permission`)
          .then((result) => loginKey(result?.user?.login) === actor
            && WRITE_PERMISSIONS.has(result?.permission)));
      }
      return permissions.get(actor);
    },
  };
}
