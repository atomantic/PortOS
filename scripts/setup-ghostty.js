#!/usr/bin/env node
import { existsSync, mkdirSync, cpSync, readFileSync, appendFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { homedir, platform } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const home = homedir();
const isMac = platform() === 'darwin';

const ghosttyInstalled = (() => {
  const paths = [
    '/Applications/Ghostty.app',
    join(home, 'Applications/Ghostty.app'),
    join(home, 'Documents/Ghostty.app'),
  ];
  if (paths.some(p => existsSync(p))) return true;
  try {
    execSync('command -v ghostty', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

if (!ghosttyInstalled) {
  console.log('👻 Ghostty not detected — skipping shell integration setup');
  process.exit(0);
}

console.log('👻 Setting up Ghostty shell integration...');

// 1. Copy themes → platform-specific themes directory
const themeSrc = join(rootDir, 'shell/themes');
const themeDest = isMac
  ? join(home, 'Library/Application Support/com.mitchellh.ghostty/themes')
  : join(home, '.config/ghostty/themes');
mkdirSync(themeDest, { recursive: true });

const themeFiles = readdirSync(themeSrc).filter(f => f.endsWith('.conf'));
for (const file of themeFiles) {
  cpSync(join(themeSrc, file), join(themeDest, file));
}
console.log(`✅ Copied ${themeFiles.length} themes → ${themeDest}`);

// 2. Add source line to zshrc (ghostty.sh uses zsh-specific hooks)
const zshrcPath = join(home, '.zshrc');
const sourceLine = `source "${join(rootDir, 'shell/ghostty.sh')}"`;

if (!existsSync(zshrcPath)) {
  console.log('⚠️  ~/.zshrc not found — Ghostty shell integration requires zsh');
  console.log('   To set up manually, add this to your zsh config:');
  console.log(`   ${sourceLine}`);
} else {
  const rcContent = readFileSync(zshrcPath, 'utf8');
  if (rcContent.includes(sourceLine)) {
    console.log(`✅ Shell integration already in ${zshrcPath}`);
  } else {
    appendFileSync(zshrcPath, `\n# PortOS Ghostty shell integration\n${sourceLine}\n`);
    console.log(`✅ Added source line to ${zshrcPath}`);
  }
}

console.log('');
console.log('👻 Ghostty setup complete!');
console.log('   Restart your shell or run: source ~/.zshrc');
console.log('   Try: proj . blue');
