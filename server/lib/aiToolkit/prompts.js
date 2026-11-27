import { readFile, stat, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { atomicWrite } from './internal/atomicWrite.js';

export function createPromptsService(config = {}) {
  const {
    dataDir = './data',
    promptsDir = 'prompts'
  } = config;

  const PROMPTS_PATH = join(dataDir, promptsDir);

  const configPath = join(PROMPTS_PATH, 'stage-config.json');
  const variablesPath = join(PROMPTS_PATH, 'variables.json');
  const stageTemplatePath = (stageName) => join(PROMPTS_PATH, 'stages', `${stageName}.md`);

  let stageConfig = null;
  let variables = null;
  let initPromise;
  let configWriteTail = Promise.resolve();
  let variablesWriteTail = Promise.resolve();

  async function readState(path, fallback) {
    return existsSync(path) ? JSON.parse(await readFile(path, 'utf-8')) : fallback;
  }

  async function readPrompts() {
    const nextConfig = await readState(configPath, { stages: {} });
    const nextVariables = await readState(variablesPath, { variables: {} });
    stageConfig = nextConfig;
    variables = nextVariables;
    console.log(`📝 Loaded ${Object.keys(stageConfig.stages || {}).length} prompt stages`);
  }

  function withBothWriteQueues(fn) {
    const result = Promise.all([configWriteTail, variablesWriteTail]).then(fn);
    configWriteTail = variablesWriteTail = result.catch(() => {});
    return result;
  }

  function loadPrompts() {
    if (!initPromise) {
      initPromise = withBothWriteQueues(readPrompts).finally(() => { initPromise = undefined; });
    }
    return initPromise;
  }

  function enqueueConfigWrite(write, needsConfig = true) {
    const ready = needsConfig && (initPromise ?? (!stageConfig && loadPrompts()));
    const result = Promise.all([configWriteTail, ready]).then(write);
    configWriteTail = result.catch(() => {});
    return result;
  }

  function enqueueVariablesWrite(write) {
    const ready = initPromise ?? (!variables && loadPrompts());
    const result = Promise.all([variablesWriteTail, ready]).then(write);
    variablesWriteTail = result.catch(() => {});
    return result;
  }

  async function saveStages(stages) {
    const next = { ...stageConfig, stages };
    await atomicWrite(configPath, next);
    stageConfig = next;
  }

  async function saveVariables(entries) {
    const next = { ...variables, variables: entries };
    await atomicWrite(variablesPath, next);
    variables = next;
  }

  async function saveWithStageTemplate(stageName, content, saveConfig) {
    const path = stageTemplatePath(stageName);
    const original = await readFile(path).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });

    // A failed config write must leave the previous template available to readers.
    let originalMode;
    if (content !== null) {
      await atomicWrite(path, content);
    } else if (original !== null) {
      originalMode = (await stat(path)).mode & 0o777;
      await unlink(path);
    }

    try {
      await saveConfig();
    } catch (error) {
      try {
        if (original !== null) await atomicWrite(path, original, { mode: originalMode });
        else if (content !== null) await unlink(path);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], `Could not restore template for stage ${stageName}`);
      }
      throw error;
    }
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
          return content.replace(/\{\{\.\}\}/g, () => item);
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

    withLiveRestore(operation) {
      return withBothWriteQueues(() => operation(async () => {
        // A failed read must never leave the old state available to a writer.
        stageConfig = variables = null;
        await readPrompts();
      }));
    },

    getStages() {
      return stageConfig?.stages || {};
    },

    getStage(stageName) {
      return stageConfig?.stages?.[stageName] || null;
    },

    async getStageTemplate(stageName) {
      const templatePath = stageTemplatePath(stageName);
      if (!existsSync(templatePath)) return null;
      return readFile(templatePath, 'utf-8');
    },

    async updateStageTemplate(stageName, content) {
      await enqueueConfigWrite(() => atomicWrite(stageTemplatePath(stageName), content), false);
    },

    async updateStageConfig(stageName, updatedConfig, template) {
      await enqueueConfigWrite(async () => {
        const stages = {
          ...stageConfig.stages,
          [stageName]: { ...stageConfig.stages[stageName], ...updatedConfig }
        };
        if (template === undefined) await saveStages(stages);
        else await saveWithStageTemplate(stageName, template, () => saveStages(stages));
      });
    },

    async createStage(stageName, config, template = '') {
      await enqueueConfigWrite(async () => {
        if (stageConfig.stages[stageName]) {
          throw new Error(`Stage ${stageName} already exists`);
        }
        const stages = { ...stageConfig.stages, [stageName]: config };
        await saveWithStageTemplate(stageName, template, () => saveStages(stages));
        console.log(`✅ Created prompt stage: ${stageName}`);
      });
    },

    async deleteStage(stageName) {
      await enqueueConfigWrite(async () => {
        if (!stageConfig.stages[stageName]) {
          throw new Error(`Stage ${stageName} not found`);
        }
        const stages = { ...stageConfig.stages };
        delete stages[stageName];
        await saveWithStageTemplate(stageName, null, () => saveStages(stages));
        console.log(`🗑️ Deleted prompt stage: ${stageName}`);
      });
    },

    getVariables() {
      return variables?.variables || {};
    },

    getVariable(key) {
      return variables?.variables?.[key] || null;
    },

    async updateVariable(key, data) {
      await enqueueVariablesWrite(() => saveVariables({
        ...variables.variables,
        [key]: { ...variables.variables[key], ...data }
      }));
    },

    async createVariable(key, data) {
      await enqueueVariablesWrite(async () => {
        if (variables.variables[key]) {
          throw new Error(`Variable ${key} already exists`);
        }
        await saveVariables({ ...variables.variables, [key]: data });
      });
    },

    async deleteVariable(key) {
      await enqueueVariablesWrite(async () => {
        const entries = { ...variables.variables };
        delete entries[key];
        await saveVariables(entries);
      });
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
