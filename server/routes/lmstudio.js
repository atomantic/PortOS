/**
 * LM Studio Routes
 *
 * REST endpoints for LM Studio model management.
 */

import { Router } from 'express'
import * as lmStudioManager from '../services/lmStudioManager.js'
import * as localThinking from '../services/localThinking.js'

const router = Router()

/**
 * GET /api/lmstudio/status
 * Check LM Studio availability and loaded models
 */
router.get('/status', async (req, res) => {
  const status = await lmStudioManager.getStatus()
  const thinkingStats = localThinking.getStats()

  res.json({
    ...status,
    thinkingStats
  })
})

/**
 * GET /api/lmstudio/models
 * List available/loaded models
 */
router.get('/models', async (req, res) => {
  const available = await lmStudioManager.checkLMStudioAvailable()

  if (!available) {
    return res.status(503).json({
      error: 'LM Studio not available',
      available: false
    })
  }

  const models = await lmStudioManager.getLoadedModels(true)
  const recommended = await lmStudioManager.getRecommendedThinkingModel()

  res.json({
    available: true,
    count: models.length,
    models,
    recommendedThinkingModel: recommended
  })
})

/**
 * POST /api/lmstudio/download
 * Download a model by ID
 */
router.post('/download', async (req, res) => {
  const { modelId } = req.body

  if (!modelId) {
    return res.status(400).json({ error: 'modelId is required' })
  }

  const result = await lmStudioManager.downloadModel(modelId)
  res.json(result)
})

/**
 * POST /api/lmstudio/load
 * Load a model into memory
 */
router.post('/load', async (req, res) => {
  const { modelId } = req.body

  if (!modelId) {
    return res.status(400).json({ error: 'modelId is required' })
  }

  const result = await lmStudioManager.loadModel(modelId)
  res.json(result)
})

/**
 * POST /api/lmstudio/unload
 * Unload a model from memory
 */
router.post('/unload', async (req, res) => {
  const { modelId } = req.body

  if (!modelId) {
    return res.status(400).json({ error: 'modelId is required' })
  }

  const result = await lmStudioManager.unloadModel(modelId)
  res.json(result)
})

/**
 * POST /api/lmstudio/completion
 * Quick completion using local model
 */
router.post('/completion', async (req, res) => {
  const { prompt, model, maxTokens, temperature, systemPrompt } = req.body

  if (!prompt) {
    return res.status(400).json({ error: 'prompt is required' })
  }

  const result = await lmStudioManager.quickCompletion(prompt, {
    model,
    maxTokens,
    temperature,
    systemPrompt
  })

  res.json(result)
})

/**
 * POST /api/lmstudio/analyze-task
 * Analyze a task for complexity and escalation needs
 */
router.post('/analyze-task', async (req, res) => {
  const { description, id, metadata } = req.body

  if (!description) {
    return res.status(400).json({ error: 'description is required' })
  }

  const analysis = await localThinking.analyzeTask({
    id,
    description,
    metadata
  })

  res.json(analysis)
})

/**
 * POST /api/lmstudio/classify-memory
 * Classify memory content
 */
router.post('/classify-memory', async (req, res) => {
  const { content } = req.body

  if (!content) {
    return res.status(400).json({ error: 'content is required' })
  }

  const classification = await localThinking.classifyMemory(content)
  res.json(classification)
})

/**
 * POST /api/lmstudio/embeddings
 * Get embeddings for text
 */
router.post('/embeddings', async (req, res) => {
  const { text, model } = req.body

  if (!text) {
    return res.status(400).json({ error: 'text is required' })
  }

  const result = await lmStudioManager.getEmbeddings(text, { model })
  res.json(result)
})

/**
 * PUT /api/lmstudio/config
 * Update LM Studio configuration
 */
router.put('/config', async (req, res) => {
  const { baseUrl, timeout, defaultThinkingModel } = req.body

  const config = lmStudioManager.updateConfig({
    baseUrl,
    timeout,
    defaultThinkingModel
  })

  res.json({ success: true, config })
})

/**
 * GET /api/lmstudio/thinking-stats
 * Get local thinking statistics
 */
router.get('/thinking-stats', (req, res) => {
  const stats = localThinking.getStats()
  res.json(stats)
})

/**
 * POST /api/lmstudio/reset-cache
 * Reset LM Studio cached state
 */
router.post('/reset-cache', (req, res) => {
  lmStudioManager.resetCache()
  res.json({ success: true, message: 'Cache reset' })
})

export default router
