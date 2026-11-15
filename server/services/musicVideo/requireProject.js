/**
 * The one "load this music-video project or answer 404" guard for services and
 * routes. A leaf beside projects.js rather than an export of it: ~30 suites
 * `vi.mock('./projects.js')` with a getProject-only factory, and those mocks
 * keep reaching this guard through its import of getProject.
 */
import { ServerError } from '../../lib/errorHandler.js';
import { getProject } from './projects.js';

/** `options` are getProject's (`catalogReads`); left out, getProject is called with the id alone. */
export async function requireProject(id, options = null) {
  const project = await (options ? getProject(id, options) : getProject(id));
  if (!project) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  return project;
}
