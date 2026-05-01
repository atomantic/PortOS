/**
 * Creative Director — bundled prompt-stage seeder.
 *
 * Why this exists: PortOS treats `data/prompts/` as user-editable runtime
 * state and gitignores it, so prompt stages added at the code level never
 * land on a fresh install. This seeder bundles the CD treatment + evaluate
 * templates inside the PortOS repo (alongside `agentBridge.js`) and copies
 * them into `data/prompts/stages/` on server boot when they're missing.
 *
 * The user's own edits in the Prompts Manager are sticky — once a stage
 * exists in `stage-config.json` we DON'T overwrite the .md template, so a
 * customized prompt survives a server restart. The seeder is purely a
 * "create on first run" hook.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { PATHS } from '../../lib/fileUtils.js';

const SEED_DIR = join(dirname(fileURLToPath(import.meta.url)), 'prompts');

const CD_STAGES = [
  {
    name: 'cd-treatment',
    config: {
      name: 'Creative Director — Treatment',
      description: 'Plan a long-form generated-video project: write the logline, synopsis, and scene-by-scene treatment.',
      model: 'default',
      returnsJson: false,
      variables: [],
    },
  },
  {
    name: 'cd-evaluate',
    config: {
      name: 'Creative Director — Scene Evaluation',
      description: 'Evaluate a freshly-rendered scene against the project style spec and scene intent. Reads multi-frame samples to judge intent across the full clip timeline.',
      model: 'default',
      returnsJson: false,
      variables: [],
    },
  },
];

export async function seedCreativeDirectorPrompts() {
  const promptsRoot = join(PATHS.data, 'prompts');
  const stagesDir = join(promptsRoot, 'stages');
  const configPath = join(promptsRoot, 'stage-config.json');

  if (!existsSync(stagesDir)) await mkdir(stagesDir, { recursive: true });

  // Read-or-init the stage config. Toolkit's prompts service treats a
  // missing file as `{ stages: {} }`; mirror that so we don't crash the
  // seeder on a fresh install.
  let stageConfig = { stages: {} };
  if (existsSync(configPath)) {
    const raw = await readFile(configPath, 'utf-8').catch(() => null);
    if (raw) stageConfig = JSON.parse(raw);
    if (!stageConfig.stages) stageConfig.stages = {};
  }

  let configChanged = false;
  let templatesWritten = 0;

  for (const { name, config } of CD_STAGES) {
    if (!stageConfig.stages[name]) {
      stageConfig.stages[name] = config;
      configChanged = true;
    }
    const targetTemplate = join(stagesDir, `${name}.md`);
    if (!existsSync(targetTemplate)) {
      const sourceTemplate = join(SEED_DIR, `${name}.md`);
      const body = await readFile(sourceTemplate, 'utf-8');
      await writeFile(targetTemplate, body);
      templatesWritten += 1;
    }
  }

  if (configChanged) {
    await writeFile(configPath, JSON.stringify(stageConfig, null, 2));
  }
  if (configChanged || templatesWritten > 0) {
    console.log(`📝 CD prompt seeder: ${configChanged ? 'config updated, ' : ''}${templatesWritten} template(s) written`);
  }
}
