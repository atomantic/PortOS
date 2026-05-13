import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

export function createPromptsService(config = {}) {
  const {
    dataDir = './data',
    promptsDir = 'prompts'
  } = config;

  const PROMPTS_PATH = join(dataDir, promptsDir);

  let stageConfig = null;
  let variables = null;

  // mkdir -p the prompts dir before writes — on a fresh data directory the
  // dir may not exist yet and writes to `stage-config.json` / `variables.json`
  // would fail with ENOENT before the per-write `stagesDir` mkdir runs.
  async function ensurePromptsDir() {
    if (!existsSync(PROMPTS_PATH)) await mkdir(PROMPTS_PATH, { recursive: true });
  }

  async function loadPrompts() {
    const configPath = join(PROMPTS_PATH, 'stage-config.json');
    const varsPath = join(PROMPTS_PATH, 'variables.json');

    if (existsSync(configPath)) {
      stageConfig = JSON.parse(await readFile(configPath, 'utf-8'));
    } else {
      stageConfig = { stages: {} };
    }

    if (existsSync(varsPath)) {
      variables = JSON.parse(await readFile(varsPath, 'utf-8'));
    } else {
      variables = { variables: {} };
    }

    console.log(`📝 Loaded ${Object.keys(stageConfig.stages || {}).length} prompt stages`);
  }

  function applyTemplate(template, data) {
    let result = template;

    result = result.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (match, key, content) => {
      const value = data[key];
      if (!value) return '';
      if (Array.isArray(value)) {
        return value.map(item => {
          if (typeof item === 'object') {
            return applyTemplate(content, item);
          }
          return content.replace(/\{\{\.\}\}/g, item);
        }).join('');
      }
      return applyTemplate(content, data);
    });

    result = result.replace(/\{\{\^(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (match, key, content) => {
      return data[key] ? '' : content;
    });

    result = result.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      return data[key] !== undefined ? String(data[key]) : '';
    });

    return result.trim();
  }

  return {
    async init() {
      await loadPrompts();
    },

    getStages() {
      return stageConfig?.stages || {};
    },

    getStage(stageName) {
      return stageConfig?.stages?.[stageName] || null;
    },

    async getStageTemplate(stageName) {
      const templatePath = join(PROMPTS_PATH, 'stages', `${stageName}.md`);
      if (!existsSync(templatePath)) return null;
      return readFile(templatePath, 'utf-8');
    },

    async updateStageTemplate(stageName, content) {
      const stagesDir = join(PROMPTS_PATH, 'stages');
      if (!existsSync(stagesDir)) await mkdir(stagesDir, { recursive: true });
      await writeFile(join(stagesDir, `${stageName}.md`), content);
    },

    async updateStageConfig(stageName, updatedConfig) {
      if (!stageConfig) await loadPrompts();
      stageConfig.stages[stageName] = { ...stageConfig.stages[stageName], ...updatedConfig };
      await ensurePromptsDir();
      await writeFile(join(PROMPTS_PATH, 'stage-config.json'), JSON.stringify(stageConfig, null, 2));
    },

    async createStage(stageName, config, template = '') {
      if (!stageConfig) await loadPrompts();
      if (stageConfig.stages[stageName]) {
        throw new Error(`Stage ${stageName} already exists`);
      }
      stageConfig.stages[stageName] = config;
      await ensurePromptsDir();
      await writeFile(join(PROMPTS_PATH, 'stage-config.json'), JSON.stringify(stageConfig, null, 2));

      const stagesDir = join(PROMPTS_PATH, 'stages');
      if (!existsSync(stagesDir)) await mkdir(stagesDir, { recursive: true });
      await writeFile(join(stagesDir, `${stageName}.md`), template);

      console.log(`✅ Created prompt stage: ${stageName}`);
    },

    async deleteStage(stageName) {
      if (!stageConfig) await loadPrompts();
      if (!stageConfig.stages[stageName]) {
        throw new Error(`Stage ${stageName} not found`);
      }
      delete stageConfig.stages[stageName];
      await ensurePromptsDir();
      await writeFile(join(PROMPTS_PATH, 'stage-config.json'), JSON.stringify(stageConfig, null, 2));

      const templatePath = join(PROMPTS_PATH, 'stages', `${stageName}.md`);
      if (existsSync(templatePath)) {
        const { unlink } = await import('fs/promises');
        await unlink(templatePath);
      }

      console.log(`🗑️ Deleted prompt stage: ${stageName}`);
    },

    getVariables() {
      return variables?.variables || {};
    },

    getVariable(key) {
      return variables?.variables?.[key] || null;
    },

    async updateVariable(key, data) {
      if (!variables) await loadPrompts();
      variables.variables[key] = { ...variables.variables[key], ...data };
      await ensurePromptsDir();
      await writeFile(join(PROMPTS_PATH, 'variables.json'), JSON.stringify(variables, null, 2));
    },

    async createVariable(key, data) {
      if (!variables) await loadPrompts();
      if (variables.variables[key]) {
        throw new Error(`Variable ${key} already exists`);
      }
      variables.variables[key] = data;
      await ensurePromptsDir();
      await writeFile(join(PROMPTS_PATH, 'variables.json'), JSON.stringify(variables, null, 2));
    },

    async deleteVariable(key) {
      if (!variables) await loadPrompts();
      delete variables.variables[key];
      await ensurePromptsDir();
      await writeFile(join(PROMPTS_PATH, 'variables.json'), JSON.stringify(variables, null, 2));
    },

    async buildPrompt(stageName, data = {}) {
      const stage = stageConfig?.stages?.[stageName];
      if (!stage) throw new Error(`Stage ${stageName} not found`);

      const template = await this.getStageTemplate(stageName);
      if (!template) throw new Error(`Template for ${stageName} not found`);

      const allVars = { ...data };
      for (const varName of stage.variables || []) {
        const v = variables?.variables?.[varName];
        if (v) allVars[varName] = v.content;
      }

      return applyTemplate(template, allVars);
    },

    async previewPrompt(stageName, testData = {}) {
      return this.buildPrompt(stageName, testData);
    }
  };
}
