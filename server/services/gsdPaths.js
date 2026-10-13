/** Repository-controlled planning files must never redirect host file access. */
import { realpath } from 'fs/promises'
import { join } from 'path'
import { isSymlinkFreeRepoPath } from '../lib/repoPublishPath.js'
import { ServerError } from '../lib/errorHandler.js'

export async function resolveGsdPath(repoPath, relativePath = '', leaf = 'file') {
  const root = await realpath(repoPath).catch(err => {
    if (err.code === 'ENOENT') return null
    throw err
  })
  if (!root) return null
  const target = join(root, '.planning', relativePath)
  // Use the same no-symlink policy as repository publishing, including dangling
  // leaves and missing destinations. A symlink at the configured repo root is
  // legitimate; links below that root are untrusted repository content.
  if (!await isSymlinkFreeRepoPath(root, target, { leaf })) {
    throw new ServerError('Invalid planning path', { status: 400, code: 'PATH_TRAVERSAL' })
  }
  return target
}
