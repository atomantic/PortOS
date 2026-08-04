/**
 * Local launch helpers: open the app in an editor, in Claude Code, in Xcode, or
 * in the OS file manager. Each spawns a detached child process.
 *
 *   POST /:id/open-editor → { success, command, path }
 *   POST /:id/open-claude → { success, path }
 *   POST /:id/open-folder → { success, path }
 *   POST /:id/open-xcode  → { success, path }
 */

import { Router } from 'express';
import { spawn } from 'child_process';
import { join } from 'path';
import { asyncHandler, ServerError } from '../../lib/errorHandler.js';
import { deriveProjectInfo } from '../../services/xcodeScripts.js';
import { loadApp, pathExists } from './shared.js';

const router = Router();

/**
 * Hand a path to the OS's default handler, detached. `open`/`explorer`/`xdg-open`
 * all take the path as their only argument, so folder-opening and
 * project-opening share this one launcher.
 */
function openWithSystemHandler(targetPath) {
  const cmd = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32' ? 'explorer' : 'xdg-open';

  const child = spawn(cmd, [targetPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();
}

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

  openWithSystemHandler(app.repoPath);

  res.json({ success: true, path: app.repoPath });
}));

// POST /api/apps/:id/open-xcode - Open the app's Xcode workspace/project
//
// The project filename is resolved server-side (project.yml `name:` → the
// `*.xcodeproj` on disk → the sanitized app name) rather than guessed from the
// display name on the client, and the project is opened on the machine Xcode is
// installed on — so this still works when the click comes from a phone.
router.post('/:id/open-xcode', loadApp, asyncHandler(async (req, res) => {
  const app = req.loadedApp;

  if (!await pathExists(app.repoPath)) {
    throw new ServerError('App path does not exist', { status: 400, code: 'PATH_NOT_FOUND' });
  }

  const { targetName } = await deriveProjectInfo(app.repoPath, app.name);

  // A workspace supersedes the project it wraps (CocoaPods/SPM multi-project
  // setups), so prefer it when both are present.
  let projectPath = null;
  for (const ext of ['.xcworkspace', '.xcodeproj']) {
    const candidate = join(app.repoPath, `${targetName}${ext}`);
    if (await pathExists(candidate)) {
      projectPath = candidate;
      break;
    }
  }

  if (!projectPath) {
    throw new ServerError(
      `No ${targetName}.xcworkspace or ${targetName}.xcodeproj found in ${app.repoPath}`,
      { status: 404, code: 'XCODE_PROJECT_NOT_FOUND', context: { targetName, repoPath: app.repoPath } }
    );
  }

  openWithSystemHandler(projectPath);

  console.log(`📱 Opened Xcode project for ${app.name}: ${targetName}`);
  res.json({ success: true, path: projectPath });
}));

export default router;
