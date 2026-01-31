/**
 * LM Studio Manager Service
 *
 * Manages local LM Studio models for free local thinking.
 * Provides model discovery, loading, unloading, and downloading.
 */

import { cosEvents } from './cos.js'

// Default LM Studio configuration
const DEFAULT_CONFIG = {
  baseUrl: 'http://localhost:1234',
  timeout: 30000,
  defaultThinkingModel: 'gpt-oss-20b'
}

// Cached state
let config = { ...DEFAULT_CONFIG }
let isAvailable = null
let loadedModels = []
let availableModels = []
let lastCheckAt = null

// Status tracking
const status = {
  lastError: null,
  lastSuccessAt: null,
  consecutiveErrors: 0
}

/**
 * Make a request to LM Studio API
 * @param {string} endpoint - API endpoint
 * @param {Object} options - Fetch options
 * @returns {Promise<*>} - Response data
 */
async function lmStudioRequest(endpoint, options = {}) {
  const url = `${config.baseUrl}${endpoint}`
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), options.timeout || config.timeout)

  const response = await fetch(url, {
    ...options,
    signal: controller.signal,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers
    }
  }).finally(() => clearTimeout(timeoutId))

  if (!response.ok) {
    throw new Error(`LM Studio API error: ${response.status} ${response.statusText}`)
  }

  return response.json()
}

/**
 * Check if LM Studio is available
 * @returns {Promise<boolean>} - True if available
 */
async function checkLMStudioAvailable() {
  const now = Date.now()

  // Use cached result if recent (within 30 seconds)
  if (lastCheckAt && now - lastCheckAt < 30000 && isAvailable !== null) {
    return isAvailable
  }

  try {
    await lmStudioRequest('/v1/models', { timeout: 5000 })
    isAvailable = true
    status.lastSuccessAt = now
    status.consecutiveErrors = 0
    status.lastError = null
    lastCheckAt = now
    return true
  } catch (err) {
    isAvailable = false
    status.lastError = err.message
    status.consecutiveErrors++
    lastCheckAt = now
    return false
  }
}

/**
 * Get currently loaded models
 * @param {boolean} forceRefresh - Force refresh from API
 * @returns {Promise<Array>} - Loaded models
 */
async function getLoadedModels(forceRefresh = false) {
  if (!forceRefresh && loadedModels.length > 0) {
    return loadedModels
  }

  const available = await checkLMStudioAvailable()
  if (!available) {
    return []
  }

  try {
    const response = await lmStudioRequest('/v1/models')
    loadedModels = (response.data || []).map(model => ({
      id: model.id,
      object: model.object,
      created: model.created,
      ownedBy: model.owned_by
    }))
    return loadedModels
  } catch (err) {
    console.error(`⚠️ Failed to get LM Studio models: ${err.message}`)
    return []
  }
}

/**
 * Get available models in LM Studio catalog
 * Note: This requires LM Studio's /lmstudio.* endpoints if available
 * @returns {Promise<Array>} - Available models
 */
async function getAvailableModels() {
  const available = await checkLMStudioAvailable()
  if (!available) {
    return []
  }

  // LM Studio doesn't have a public catalog API by default
  // Return loaded models as available for now
  return getLoadedModels(true)
}

/**
 * Download a model from LM Studio catalog
 * Note: Requires LM Studio API support for downloads
 *
 * @param {string} modelId - Model identifier to download
 * @returns {Promise<Object>} - Download result
 */
async function downloadModel(modelId) {
  const available = await checkLMStudioAvailable()
  if (!available) {
    return {
      success: false,
      error: 'LM Studio not available'
    }
  }

  // LM Studio doesn't have a public download API
  // This would need to be implemented via LM Studio's developer API
  console.log(`📥 Model download requested: ${modelId}`)
  cosEvents.emit('lmstudio:downloadRequested', { modelId })

  return {
    success: false,
    error: 'Model downloading not yet supported via API',
    modelId,
    instruction: 'Please download the model manually via LM Studio UI'
  }
}

/**
 * Load a model into LM Studio memory
 * @param {string} modelId - Model identifier to load
 * @returns {Promise<Object>} - Load result
 */
async function loadModel(modelId) {
  const available = await checkLMStudioAvailable()
  if (!available) {
    return { success: false, error: 'LM Studio not available' }
  }

  try {
    // Try to make a test completion to trigger model loading
    await lmStudioRequest('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'test' }],
        max_tokens: 1
      }),
      timeout: 60000 // Loading can take a while
    })

    // Refresh loaded models
    await getLoadedModels(true)

    console.log(`📦 Model loaded: ${modelId}`)
    cosEvents.emit('lmstudio:modelLoaded', { modelId })

    return { success: true, modelId }
  } catch (err) {
    console.error(`⚠️ Failed to load model ${modelId}: ${err.message}`)
    return { success: false, error: err.message, modelId }
  }
}

/**
 * Unload a model from LM Studio memory
 * Note: Requires LM Studio API support for unloading
 *
 * @param {string} modelId - Model identifier to unload
 * @returns {Promise<Object>} - Unload result
 */
async function unloadModel(modelId) {
  const available = await checkLMStudioAvailable()
  if (!available) {
    return { success: false, error: 'LM Studio not available' }
  }

  // LM Studio doesn't have a public unload API
  console.log(`📤 Model unload requested: ${modelId}`)
  cosEvents.emit('lmstudio:unloadRequested', { modelId })

  return {
    success: false,
    error: 'Model unloading not yet supported via API',
    modelId,
    instruction: 'Please unload the model manually via LM Studio UI'
  }
}

/**
 * Get the recommended thinking model
 * @returns {Promise<string|null>} - Model ID or null if none available
 */
async function getRecommendedThinkingModel() {
  const models = await getLoadedModels()

  if (models.length === 0) {
    return null
  }

  // Prefer specific thinking-optimized models
  const preferredModels = [
    'gpt-oss-20b',
    'deepseek-r1',
    'qwen2.5-coder',
    'codellama',
    'mistral',
    'llama'
  ]

  for (const preferred of preferredModels) {
    const match = models.find(m =>
      m.id.toLowerCase().includes(preferred.toLowerCase())
    )
    if (match) return match.id
  }

  // Return first available model
  return models[0]?.id || null
}

/**
 * Make a quick completion request for local thinking
 * @param {string} prompt - Prompt text
 * @param {Object} options - Completion options
 * @returns {Promise<Object>} - Completion result
 */
async function quickCompletion(prompt, options = {}) {
  const available = await checkLMStudioAvailable()
  if (!available) {
    return { success: false, error: 'LM Studio not available' }
  }

  const model = options.model || await getRecommendedThinkingModel()
  if (!model) {
    return { success: false, error: 'No model available' }
  }

  try {
    const response = await lmStudioRequest('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model,
        messages: [
          ...(options.systemPrompt ? [{ role: 'system', content: options.systemPrompt }] : []),
          { role: 'user', content: prompt }
        ],
        max_tokens: options.maxTokens || 512,
        temperature: options.temperature ?? 0.7,
        stream: false
      }),
      timeout: options.timeout || 30000
    })

    const content = response.choices?.[0]?.message?.content || ''

    return {
      success: true,
      content,
      model,
      usage: response.usage
    }
  } catch (err) {
    return { success: false, error: err.message, model }
  }
}

/**
 * Get embeddings from local model
 * @param {string} text - Text to embed
 * @param {Object} options - Embedding options
 * @returns {Promise<Object>} - Embedding result
 */
async function getEmbeddings(text, options = {}) {
  const available = await checkLMStudioAvailable()
  if (!available) {
    return { success: false, error: 'LM Studio not available' }
  }

  const model = options.model || 'text-embedding-nomic-embed-text-v2-moe'

  try {
    const response = await lmStudioRequest('/v1/embeddings', {
      method: 'POST',
      body: JSON.stringify({
        model,
        input: text
      }),
      timeout: options.timeout || 10000
    })

    const embedding = response.data?.[0]?.embedding || []

    return {
      success: true,
      embedding,
      model,
      dimensions: embedding.length
    }
  } catch (err) {
    return { success: false, error: err.message, model }
  }
}

/**
 * Get LM Studio status
 * @returns {Promise<Object>} - Status information
 */
async function getStatus() {
  const available = await checkLMStudioAvailable()
  const models = available ? await getLoadedModels() : []

  return {
    available,
    baseUrl: config.baseUrl,
    loadedModels: models.length,
    models: models.map(m => m.id),
    recommendedThinkingModel: available ? await getRecommendedThinkingModel() : null,
    lastCheckAt: lastCheckAt ? new Date(lastCheckAt).toISOString() : null,
    lastSuccessAt: status.lastSuccessAt ? new Date(status.lastSuccessAt).toISOString() : null,
    lastError: status.lastError,
    consecutiveErrors: status.consecutiveErrors
  }
}

/**
 * Update configuration
 * @param {Object} newConfig - New configuration
 * @returns {Object} - Updated configuration
 */
function updateConfig(newConfig) {
  if (newConfig.baseUrl) {
    config.baseUrl = newConfig.baseUrl
    isAvailable = null // Force recheck
    lastCheckAt = null
  }

  if (newConfig.timeout) {
    config.timeout = newConfig.timeout
  }

  if (newConfig.defaultThinkingModel) {
    config.defaultThinkingModel = newConfig.defaultThinkingModel
  }

  return { ...config }
}

/**
 * Reset cached state
 */
function resetCache() {
  isAvailable = null
  loadedModels = []
  availableModels = []
  lastCheckAt = null
}

export {
  checkLMStudioAvailable,
  getLoadedModels,
  getAvailableModels,
  downloadModel,
  loadModel,
  unloadModel,
  getRecommendedThinkingModel,
  quickCompletion,
  getEmbeddings,
  getStatus,
  updateConfig,
  resetCache,
  DEFAULT_CONFIG
}
