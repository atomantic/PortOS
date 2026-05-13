import { Router } from 'express';

export function createPromptsRoutes(promptsService, options = {}) {
  const router = Router();
  const { asyncHandler = (fn) => fn } = options;

  router.get('/stages', asyncHandler(async (req, res) => {
    const stages = promptsService.getStages();
    res.json(stages);
  }));

  router.get('/stages/:name', asyncHandler(async (req, res) => {
    const stage = promptsService.getStage(req.params.name);

    if (!stage) {
      return res.status(404).json({ error: 'Stage not found' });
    }

    const template = await promptsService.getStageTemplate(req.params.name);
    res.json({ ...stage, template });
  }));

  router.put('/stages/:name', asyncHandler(async (req, res) => {
    const { config, template } = req.body;

    if (config) {
      await promptsService.updateStageConfig(req.params.name, config);
    }

    if (template) {
      await promptsService.updateStageTemplate(req.params.name, template);
    }

    const updated = promptsService.getStage(req.params.name);
    const updatedTemplate = await promptsService.getStageTemplate(req.params.name);

    res.json({ ...updated, template: updatedTemplate });
  }));

  router.post('/stages/:name/preview', asyncHandler(async (req, res) => {
    const preview = await promptsService.previewPrompt(req.params.name, req.body);
    res.json({ preview });
  }));

  router.get('/variables', asyncHandler(async (req, res) => {
    const variables = promptsService.getVariables();
    res.json(variables);
  }));

  router.get('/variables/:key', asyncHandler(async (req, res) => {
    const variable = promptsService.getVariable(req.params.key);

    if (!variable) {
      return res.status(404).json({ error: 'Variable not found' });
    }

    res.json(variable);
  }));

  router.post('/variables', asyncHandler(async (req, res) => {
    const { key, ...data } = req.body;

    if (!key) {
      return res.status(400).json({ error: 'Variable key is required' });
    }

    await promptsService.createVariable(key, data);
    const created = promptsService.getVariable(key);
    res.status(201).json(created);
  }));

  router.put('/variables/:key', asyncHandler(async (req, res) => {
    await promptsService.updateVariable(req.params.key, req.body);
    const updated = promptsService.getVariable(req.params.key);
    res.json(updated);
  }));

  router.delete('/variables/:key', asyncHandler(async (req, res) => {
    await promptsService.deleteVariable(req.params.key);
    res.status(204).send();
  }));

  return router;
}
