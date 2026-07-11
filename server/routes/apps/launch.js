/**
 * Local launch helpers: open the app in an editor, in Claude Code, or in the
 * OS file manager. Each spawns a detached child process.
 *
 *   POST /:id/open-editor → { success, command, path }
 *   POST /:id/open-claude → { success, path }
 *   POST /:id/open-folder → { success, path }
 */

import { Router } from 'express';
import { spawn } from 'child_process';
import { asyncHandler, ServerError } from '../../lib/errorHandler.js';
import { loadApp, pathExists } from './shared.js';

const router = Router();

// Allowlist of safe editor commands
// Security: Only allow known-safe editor commands to prevent arbitrary code execution
const ALLOWED_EDITORS = new Set([
  'code',      // VS Code
  'cursor',    // Cursor
  'zed',       // Zed
  'subl',      // Sublime Text
  'atom',      // Atom
  'vim',       // Vim
  'nvim',      // Neovim
  'nano',      // Nano
  'emacs',     // Emacs
  'idea',      // IntelliJ IDEA
  'pycharm',   // PyCharm
  'webstorm',  // WebStorm
  'phpstorm',  // PhpStorm
  'rubymine',  // RubyMine
  'goland',    // GoLand
  'clion',     // CLion
  'rider',     // Rider
  'studio',    // Android Studio
  'xed'        // Xcode
]);

// POST /api/apps/:id/open-editor - Open app in editor
router.post('/:id/open-editor', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;

  if (!await pathExists(app.repoPath)) {
    throw new ServerError('App path does not exist', { status: 400, code: 'PATH_NOT_FOUND' });
  }

  const editorCommand = app.editorCommand || 'code .';
  const [cmd, ...args] = editorCommand.split(/\s+/);

  // Security: Validate that the editor command is in our allowlist
  // This prevents arbitrary command execution via malicious editorCommand values
  if (!ALLOWED_EDITORS.has(cmd)) {
    throw new ServerError(`Editor '${cmd}' is not in the allowed editors list`, {
      status: 400,
      code: 'INVALID_EDITOR',
      context: { allowedEditors: Array.from(ALLOWED_EDITORS) }
    });
  }

  // Security: Validate args don't contain shell metacharacters
  const DANGEROUS_CHARS = /[;|&`$(){}[\]<>\\!#*?~]/;
  for (const arg of args) {
    if (DANGEROUS_CHARS.test(arg)) {
      throw new ServerError('Editor arguments contain disallowed characters', {
        status: 400,
        code: 'INVALID_EDITOR_ARGS'
      });
    }
  }

  // Spawn the editor process detached so it doesn't block.
  // On Windows, editor binaries are typically `.cmd`/`.bat` shims (e.g. `code.cmd`,
  // `cursor.cmd`) which Node refuses to spawn without a shell since 20.12.2 — so we
  // opt into the shell on win32. Args are pre-sanitized for shell metacharacters
  // above, and the command is allowlisted.
  const child = spawn(cmd, args, {
    cwd: app.repoPath,
    detached: true,
    stdio: 'ignore',
    shell: process.platform === 'win32',
    windowsHide: true
  });
  child.unref();

  res.json({ success: true, command: editorCommand, path: app.repoPath });
}));

// POST /api/apps/:id/open-claude - Open Claude Code in app directory
router.post('/:id/open-claude', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;

  if (!await pathExists(app.repoPath)) {
    throw new ServerError('App path does not exist', { status: 400, code: 'PATH_NOT_FOUND' });
  }

  // shell:true on Windows so `claude.cmd` resolves (see open-editor above for the
  // Node 20.12.2 rationale). No user args reach the command line here.
  const child = spawn('claude', [], {
    cwd: app.repoPath,
    detached: true,
    stdio: 'ignore',
    shell: process.platform === 'win32',
    windowsHide: true
  });
  child.unref();

  console.log(`🤖 Opened Claude Code in ${app.name}`);
  res.json({ success: true, path: app.repoPath });
}));

// POST /api/apps/:id/open-folder - Open app folder in file manager
router.post('/:id/open-folder', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;

  if (!await pathExists(app.repoPath)) {
    throw new ServerError('App path does not exist', { status: 400, code: 'PATH_NOT_FOUND' });
  }

  // Cross-platform folder open command
  const platform = process.platform;
  let cmd, args;

  if (platform === 'darwin') {
    cmd = 'open';
    args = [app.repoPath];
  } else if (platform === 'win32') {
    cmd = 'explorer';
    args = [app.repoPath];
  } else {
    cmd = 'xdg-open';
    args = [app.repoPath];
  }

  const child = spawn(cmd, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();

  res.json({ success: true, path: app.repoPath });
}));

export default router;
