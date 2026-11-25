import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { readText, REPO_ROOT, workingTreeFiles } from '../../../../scripts/lib/guardCorpus.js';

// Applied migrations remain in place for upgrades from older installs.
const ALLOWED_REGISTRY_MIGRATIONS = new Set([
  '012-mark-flux1-dev-gated.js',
  '044-hunyuan-fp32-deprecated.js',
  '045-flux2-klein-9b-kv-tokenizer.js',
  '064-flux2-klein-9b-bf16-kv-repo.js',
  '233-wan-mlx-gen-models.js',
  '237-video-model-disclosure.js',
  '238-video-finish-profiles.js',
  '242-minimax-h3-mlx-model.js',
  '244-minimax-h3-image-to-video.js',
  '247-retire-ltx2-unified.js',
  '267-minimax-h3-native-output-controls.js',
  '268-minimax-h3-cuda-model.js',
  '270-video-registry-mlx-cuda-buckets.js',
  '271-minimax-h3-mlx-denoising-count.js',
  '273-ltx-video-cuda-runtime.js',
  '295-video-speed-profiles.js',
  '314-fastvideo-mlx-models.js',
  '315-retire-hunyuan-video.js',
  '317-minimax-h3-memory-profiles.js',
  '317-minimax-h3-ref2va.js',
  '318-ltx25-a2v-duration.js',
  '333-fasth3-dense-datafree-mlx.js',
  '334-fasth3-upstream-source-mlx.js',
  '336-fastmetal-download-size-names.js',
  '398-apple-video-model-options.js',
  '444-minimax-h3-cuda-lightx2v.js',
  '445-minimax-h3-mlx-lightx2v.js',
  '455-ltx25-guided-steps.js',
].map((file) => `scripts/migrations/${file}`));

const referencesMediaRegistry = (source) => /media-models\.json/.test(source)
  || (/['"](?:[^'"]*\/)?_lib\.js['"]/.test(source)
    && /\b(?:readMediaRegistry(?:Config)?|writeMediaRegistry)\b/.test(source));

const migrationFiles = () => workingTreeFiles(REPO_ROOT, ['scripts/migrations/*.js'])
  .filter((path) => path !== 'scripts/migrations/_lib.js' && !path.endsWith('.test.js'));

describe('media-model registry migrations stay closed', () => {
  it('finds the migrations it is meant to guard', () => {
    expect(migrationFiles().length).toBeGreaterThan(100);
  });

  it('rejects new migrations that reference the media-model registry', () => {
    const offenders = migrationFiles()
      .filter((path) => !ALLOWED_REGISTRY_MIGRATIONS.has(path))
      .filter((path) => referencesMediaRegistry(readText(join(REPO_ROOT, path))));

    expect(offenders, 'Ship media-model catalog changes through the loader. See server/AGENTS.md.').toEqual([]);
  });

  it.each([
    ["const path = join(dataDir, 'media-models.json');", true],
    ["import { readMediaRegistry as read } from './_lib.js';", true],
    ["import { readMediaRegistryConfig } from './_lib.js';", true],
    ["import * as helpers from './_lib.js'; helpers.writeMediaRegistry(path, config);", true],
    ["import { readJson } from './_lib.js';", false],
  ])('detects registry access in %s', (source, expected) => {
    expect(referencesMediaRegistry(source)).toBe(expected);
  });
});
