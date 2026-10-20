/**
 * Workspace-aware `node_modules` provisioning for a worktree (#12633).
 *
 * A plain `worktree/node_modules -> source/node_modules` symlink resolves the
 * install's workspace links (`@scope/pkg -> ../../packages/pkg`) against the
 * SOURCE checkout, so a worktree whose base is ahead of the source's checked-out
 * branch silently runs the source's stale workspace packages. When the source
 * has such links, the worktree gets a real `node_modules` directory instead:
 * every entry is symlinked back to the source except the workspace links, which
 * are recreated with the same targets so they resolve inside the worktree.
 */

import { mkdir, readdir, readlink, rm, rmdir, symlink, unlink, writeFile } from 'fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path';

// Marks a directory this module built, so cleanup never mistakes a real
// `npm install` (whose workspace links look identical) for provisioned links.
export const WORKTREE_NODE_MODULES_MARKER = '.portos-worktree-links';

const isInside = (parent, child) => {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

// `@scope` directories and `.bin` hold links one level down; other package
// directories are opaque (their own contents are never inspected).
const isLinkContainer = (entry) => entry.isDirectory() && (entry.name.startsWith('@') || entry.name === '.bin');

const resolveLink = async (linkPath) => resolve(dirname(linkPath), await readlink(linkPath));

// A workspace link points into the source checkout but outside its node_modules.
async function readWorkspaceLink(sourceRoot, sourceModules, linkPath) {
  const target = await readlink(linkPath);
  const resolved = resolve(dirname(linkPath), target);
  if (!isInside(sourceRoot, resolved) || isInside(sourceModules, resolved)) return null;
  return { target, resolved };
}

async function planChild(sourceRoot, sourceModules, directory, entry) {
  const workspace = entry.isSymbolicLink()
    ? await readWorkspaceLink(sourceRoot, sourceModules, join(directory, entry.name))
    : null;
  return { name: entry.name, workspace, type: entry.isDirectory() ? 'dir' : 'file' };
}

async function planEntry(sourceRoot, sourceModules, entry) {
  const path = join(sourceModules, entry.name);
  if (entry.isSymbolicLink()) return planChild(sourceRoot, sourceModules, sourceModules, entry);
  if (!isLinkContainer(entry)) return { name: entry.name, workspace: null, type: entry.isDirectory() ? 'dir' : 'file' };
  const children = await readdir(path, { withFileTypes: true });
  return {
    name: entry.name,
    workspace: null,
    type: 'dir',
    children: await Promise.all(children.map(child => planChild(sourceRoot, sourceModules, path, child))),
  };
}

const hasWorkspaceLink = (planned) => !!planned.workspace || !!planned.children?.some(child => child.workspace);

// Recreate a workspace link under the worktree: a relative target is kept
// verbatim (it already resolves from the new location), an absolute one inside
// the source checkout is rebased onto the worktree.
function workspaceLinkTarget(sourceRoot, worktreeRoot, { target, resolved }) {
  return isAbsolute(target) ? join(worktreeRoot, relative(sourceRoot, resolved)) : target;
}

/**
 * Fail when a provisioned link would land outside the worktree. Resolves
 * lexically (no realpath) so a workspace package the branch deleted still
 * passes while a link escaping to the source checkout does not.
 */
export async function assertLinkWithinWorktree(worktreeRoot, linkPath) {
  const resolved = await resolveLink(linkPath);
  if (!isInside(worktreeRoot, resolved)) {
    throw new Error(`Workspace link ${linkPath} resolves outside the worktree (${resolved})`);
  }
}

async function createLinks(sourceRoot, worktreeRoot, sourceModules, destModules, plan) {
  const workspaceLinks = [];
  const linkEntry = async (directoryInSource, directoryInDest, planned) => {
    const destPath = join(directoryInDest, planned.name);
    if (planned.workspace) {
      await symlink(workspaceLinkTarget(sourceRoot, worktreeRoot, planned.workspace), destPath, planned.type);
      workspaceLinks.push(destPath);
      return;
    }
    await symlink(join(directoryInSource, planned.name), destPath, planned.type);
  };

  await mkdir(destModules, { recursive: true });
  await writeFile(join(destModules, WORKTREE_NODE_MODULES_MARKER), '');
  await Promise.all(plan.map(async (planned) => {
    if (!planned.children || !hasWorkspaceLink(planned)) return linkEntry(sourceModules, destModules, planned);
    const sourceDirectory = join(sourceModules, planned.name);
    const destDirectory = join(destModules, planned.name);
    await mkdir(destDirectory);
    await Promise.all(planned.children.map(child => linkEntry(sourceDirectory, destDirectory, child)));
  }));
  await Promise.all(workspaceLinks.map(linkPath => assertLinkWithinWorktree(worktreeRoot, linkPath)));
}

/**
 * Provision `<worktree>/node_modules` as a real directory whose workspace links
 * resolve inside the worktree. Returns false, creating nothing, when the source
 * has no workspace links — the caller then uses the plain directory symlink.
 */
export async function provisionWorkspaceNodeModules(sourceRoot, worktreeRoot) {
  const sourceModules = join(sourceRoot, 'node_modules');
  const destModules = join(worktreeRoot, 'node_modules');
  const entries = await readdir(sourceModules, { withFileTypes: true }).catch(() => []);
  const plan = await Promise.all(entries.map(entry => planEntry(sourceRoot, sourceModules, entry)));
  if (!plan.some(hasWorkspaceLink)) return false;

  await createLinks(sourceRoot, worktreeRoot, sourceModules, destModules, plan).catch(async (err) => {
    // A half-built directory would read as "already provisioned" to the next run.
    await rm(destModules, { recursive: true, force: true });
    throw err;
  });
  return true;
}

const ignoreCodes = (...codes) => (err) => {
  if (codes.includes(err.code)) return null;
  throw err;
};

/**
 * Undo `provisionWorkspaceNodeModules`: drop the links it created (into the
 * source's node_modules, or workspace links within the worktree) and the
 * directory itself once empty. A directory without the marker, and any real
 * package inside one, is left alone.
 */
export async function removeProvisionedNodeModules(sourceRoot, worktreeRoot) {
  const sourceModules = join(sourceRoot, 'node_modules');
  const destModules = join(worktreeRoot, 'node_modules');
  const entries = await readdir(destModules, { withFileTypes: true }).catch(ignoreCodes('ENOENT', 'ENOTDIR'));
  if (!entries?.some(entry => entry.name === WORKTREE_NODE_MODULES_MARKER)) return;

  const owned = async (linkPath) => {
    const resolved = await resolveLink(linkPath);
    return isInside(sourceModules, resolved) || (isInside(worktreeRoot, resolved) && !isInside(destModules, resolved));
  };
  const removeOwnedLink = async (path) => {
    if (await owned(path)) await unlink(path);
  };

  await Promise.all(entries.map(async (entry) => {
    const path = join(destModules, entry.name);
    if (entry.isSymbolicLink()) return removeOwnedLink(path);
    if (!isLinkContainer(entry)) return;
    const children = await readdir(path, { withFileTypes: true });
    await Promise.all(children.filter(child => child.isSymbolicLink()).map(child => removeOwnedLink(join(path, child.name))));
    await rmdir(path).catch(ignoreCodes('ENOTEMPTY', 'EEXIST'));
  }));
  await unlink(join(destModules, WORKTREE_NODE_MODULES_MARKER));
  await rmdir(destModules).catch(ignoreCodes('ENOTEMPTY', 'EEXIST'));
}
