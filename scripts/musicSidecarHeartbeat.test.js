import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const MUSIC_SIDECARS = [
  'generate_acestep.py',
  'generate_acestep15.py',
  'generate_audioldm2.py',
  'generate_minimax_music3.py',
  'generate_minimax_music3_mlx.py',
  'generate_musicgen.py',
];

describe('music sidecar liveness contract', () => {
  it.each(MUSIC_SIDECARS)('%s keeps the media-job watchdog alive during long work', (filename) => {
    const source = readFileSync(join(SCRIPTS_DIR, filename), 'utf8');
    expect(source).toMatch(/from _runner_common import[\s\S]*\bheartbeat\b/);
    expect(source).toMatch(/with heartbeat\([\s\S]*?["']generate["']/);
  });
});
