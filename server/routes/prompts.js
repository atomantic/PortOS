import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import {
  listJobSkillTemplates,
  loadJobSkillTemplate,
  saveJobSkillTemplate,
  getJobEffectivePrompt,
  getJob,
  JOB_SKILL_MAP
} from '../services/autonomousJobs.js';

/**
 * Create PortOS-specific prompts routes
 * Wraps toolkit routes to match PortOS API contract
 */
export function createPortOSPromptsRoutes(aiToolkit) {
  const router = Router();
  const promptsService = aiToolkit.services.prompts;

  // GET /api/prompts - List all stages (wrapped in {stages: ...})
  router.get('/', asyncHandler(async (req, res) => {
    const stages = promptsService.getStages();
    res.json({ stages });
  }));

  // GET /api/prompts/variables - List all variables (wrapped in {variables: ...})
  router.get('/variables', asyncHandler(async (req, res) => {
    const variables = promptsService.getVariables();
    res.json({ variables });
  }));

  // GET /api/prompts/variables/:key - Get a variable
  router.get('/variables/:key', asyncHandler(async (req, res) => {
    const variable = promptsService.getVariable(req.params.key);
    if (!variable) {
      throw new ServerError('Variable not found', { status: 404, code: 'NOT_FOUND' });
    }
    res.json({ key: req.params.key, ...variable });
  }));

  // POST /api/prompts/variables - Create a variable
  router.post('/variables', asyncHandler(async (req, res) => {
    const { key, name, category, content } = req.body;
    if (!key || !content) {
      throw new ServerError('key and content are required', { status: 400, code: 'VALIDATION_ERROR' });
    }
    await promptsService.createVariable(key, { name, category, content });
    res.json({ success: true, key });
  }));

  // PUT /api/prompts/variables/:key - Update a variable
  router.put('/variables/:key', asyncHandler(async (req, res) => {
    const { name, category, content } = req.body;
    await promptsService.updateVariable(req.params.key, { name, category, content });
    res.json({ success: true });
  }));

  // DELETE /api/prompts/variables/:key - Delete a variable
  router.delete('/variables/:key', asyncHandler(async (req, res) => {
    await promptsService.deleteVariable(req.params.key);
    res.json({ success: true });
  }));

  // === Job Skill Templates (must be before /:stage wildcard) ===

  // GET /api/prompts/skills/jobs - List all job skill templates
  router.get('/skills/jobs', asyncHandler(async (req, res) => {
    const skills = await listJobSkillTemplates();
    res.json({ skills });
  }));

  // GET /api/prompts/skills/jobs/:name - Get a job skill template
  router.get('/skills/jobs/:name', asyncHandler(async (req, res) => {
    const content = await loadJobSkillTemplate(req.params.name);
    if (!content) {
      throw new ServerError('Job skill template not found', { status: 404, code: 'NOT_FOUND' });
    }

    // Find associated job ID
    const jobId = Object.entries(JOB_SKILL_MAP).find(([, name]) => name === req.params.name)?.[0];
    const job = jobId ? await getJob(jobId) : null;

    res.json({
      name: req.params.name,
      jobId,
      content,
      jobName: job?.name || null,
      category: job?.category || null,
      interval: job?.interval || null
    });
  }));

  // PUT /api/prompts/skills/jobs/:name - Update a job skill template
  router.put('/skills/jobs/:name', asyncHandler(async (req, res) => {
    const { content } = req.body;
    if (!content) {
      throw new ServerError('content is required', { status: 400, code: 'VALIDATION_ERROR' });
    }
    await saveJobSkillTemplate(req.params.name, content);
    res.json({ success: true });
  }));

  // GET /api/prompts/skills/jobs/:name/preview - Preview the effective prompt from a job skill
  router.get('/skills/jobs/:name/preview', asyncHandler(async (req, res) => {
    const jobId = Object.entries(JOB_SKILL_MAP).find(([, name]) => name === req.params.name)?.[0];
    if (!jobId) {
      throw new ServerError('No job associated with this skill', { status: 404, code: 'NOT_FOUND' });
    }
    const job = await getJob(jobId);
    if (!job) {
      throw new ServerError('Associated job not found', { status: 404, code: 'NOT_FOUND' });
    }
    const prompt = await getJobEffectivePrompt(job);
    res.json({ preview: prompt });
  }));

  // === Stage Routes (wildcard - must be after specific paths) ===

  // GET /api/prompts/:stage - Get stage with template
  router.get('/:stage', asyncHandler(async (req, res) => {
    const stage = promptsService.getStage(req.params.stage);
    if (!stage) {
      throw new ServerError('Stage not found', { status: 404, code: 'NOT_FOUND' });
    }
    const template = await promptsService.getStageTemplate(req.params.stage);
    res.json({ ...stage, template });
  }));

  // POST /api/prompts - Create a new stage
  router.post('/', asyncHandler(async (req, res) => {
    const { stageName, name, description, model = 'default', returnsJson = false, variables = [], template = '' } = req.body;
    if (!stageName || !name) {
      throw new ServerError('stageName and name are required', { status: 400, code: 'VALIDATION_ERROR' });
    }
    const config = { name, description, model, returnsJson, variables };
    await promptsService.createStage(stageName, config, template);
    res.json({ success: true, stageName });
  }));

  // PUT /api/prompts/:stage - Update stage config and/or template
  router.put('/:stage', asyncHandler(async (req, res) => {
    const { template, ...config } = req.body;

    if (Object.keys(config).length > 0) {
      await promptsService.updateStageConfig(req.params.stage, config);
    }
    if (template !== undefined) {
      await promptsService.updateStageTemplate(req.params.stage, template);
    }
    res.json({ success: true });
  }));

  // GET /api/prompts/:stage/usage - Check if stage is in use
  router.get('/:stage/usage', asyncHandler(async (req, res) => {
    const stageName = req.params.stage;

    // Known system stages that are referenced in code
    const systemStages = {
      'cos-agent-briefing': ['CoS sub-agent task briefing'],
      'cos-evaluate': ['CoS task evaluation'],
      'cos-report-summary': ['CoS daily reports'],
      'cos-self-improvement': ['CoS self-improvement tasks'],
      'cos-task-enhance': ['CoS task prompt enhancement'],
      'brain-classifier': ['Brain thought classification'],
      'brain-daily-digest': ['Brain daily digest generation'],
      'brain-weekly-review': ['Brain weekly review generation'],
      'memory-evaluate': ['Memory extraction from agent output'],
      'app-detection': ['Project directory analysis']
    };

    const isSystemStage = stageName in systemStages;
    const usedBy = systemStages[stageName] || [];

    res.json({
      isSystemStage,
      usedBy,
      canDelete: !isSystemStage,
      warning: isSystemStage ? 'This is a system stage used by PortOS features. Deleting it may break functionality.' : null
    });
  }));

  // DELETE /api/prompts/:stage - Delete a stage
  router.delete('/:stage', asyncHandler(async (req, res) => {
    const stageName = req.params.stage;

    // Check if it's a system stage
    const systemStages = [
      'cos-agent-briefing', 'cos-evaluate', 'cos-report-summary', 'cos-self-improvement',
      'cos-task-enhance', 'brain-classifier', 'brain-daily-digest', 'brain-weekly-review',
      'memory-evaluate', 'app-detection'
    ];

    if (systemStages.includes(stageName) && req.query.force !== 'true') {
      throw new ServerError(
        'Cannot delete system stage. This stage is used by PortOS features. Add ?force=true to delete anyway.',
        { status: 400, code: 'SYSTEM_STAGE_PROTECTED' }
      );
    }

    await promptsService.deleteStage(stageName);
    res.json({ success: true });
  }));

  // POST /api/prompts/:stage/preview - Preview compiled prompt
  router.post('/:stage/preview', asyncHandler(async (req, res) => {
    const { testData = {} } = req.body;
    const preview = await promptsService.previewPrompt(req.params.stage, testData);
    res.json({ preview });
  }));

  // POST /api/prompts/reload - Reload prompts from disk
  router.post('/reload', asyncHandler(async (req, res) => {
    await promptsService.init();
    res.json({ success: true });
  }));

  return router;
}
