/**
 * LM Studio Manager Service
 *
 * Manages local LM Studio models for free local thinking.
 * Provides model discovery, loading, unloading, and downloading.
 */

import { cosEvents } from './cosEvents.js'

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

  // Use native REST API for richer model info (type, state, architecture)
  const nativeModels = await lmStudioRequest('/api/v0/models').catch(() => null)
  if (nativeModels?.data) {
    loadedModels = nativeModels.data
      .filter(model => model.state === 'loaded')
      .map(model => ({
        id: model.id,
        object: model.object || 'model',
        type: model.type,
        arch: model.arch,
        quantization: model.quantization,
        state: model.state,
        maxContextLength: model.max_context_length,
        ownedBy: model.publisher
      }))
    return loadedModels
  }

  // Fallback to OpenAI-compat endpoint
  const response = await lmStudioRequest('/v1/models').catch(() => null)
  if (response?.data) {
    loadedModels = response.data.map(model => ({
      id: model.id,
      object: model.object,
      created: model.created,
      ownedBy: model.owned_by
    }))
  }
  return loadedModels
}

/**
 * Get all downloaded models (loaded and not-loaded)
 * @returns {Promise<Array>} - All downloaded models with state info
 */
async function getAvailableModels() {
  const available = await checkLMStudioAvailable()
  if (!available) {
    return []
  }

  const response = await lmStudioRequest('/api/v0/models').catch(() => null)
  if (response?.data) {
    availableModels = response.data.map(model => ({
      id: model.id,
      type: model.type,
      arch: model.arch,
      publisher: model.publisher,
      quantization: model.quantization,
      state: model.state,
      maxContextLength: model.max_context_length
    }))
    return availableModels
  }

  // Fallback to loaded models only
  return getLoadedModels(true)
}

/**
 * Download a model from LM Studio catalog
 * @param {string} modelId - Model identifier to download
 * @returns {Promise<Object>} - Download result
 */
async function downloadModel(modelId) {
  const available = await checkLMStudioAvailable()
  if (!available) {
    return { success: false, error: 'LM Studio not available' }
  }

  console.log(`📥 Downloading model: ${modelId}`)
  cosEvents.emit('lmstudio:downloadRequested', { modelId })

  const response = await lmStudioRequest('/api/v1/models/download', {
    method: 'POST',
    body: JSON.stringify({ model: modelId }),
    timeout: 10000
  }).catch(err => ({ _err: err.message }))

  if (response._err) {
    console.error(`⚠️ Failed to start download for ${modelId}: ${response._err}`)
    return { success: false, error: response._err, modelId }
  }

  return { success: true, modelId, ...response }
}

/**
 * Load a model into LM Studio memory
 * @param {string} modelId - Model identifier (publisher/model-name format)
 * @returns {Promise<Object>} - Load result
 */
async function loadModel(modelId) {
  const available = await checkLMStudioAvailable()
  if (!available) {
    return { success: false, error: 'LM Studio not available' }
  }

  // Use the native REST API load endpoint
  const response = await lmStudioRequest('/api/v1/models/load', {
    method: 'POST',
    body: JSON.stringify({ model: modelId }),
    timeout: 60000 // Loading can take a while
  }).catch(err => ({ _err: err.message }))

  if (response._err) {
    console.error(`⚠️ Failed to load model ${modelId}: ${response._err}`)
    return { success: false, error: response._err, modelId }
  }

  // Refresh loaded models
  await getLoadedModels(true)

  console.log(`📦 Model loaded: ${modelId}`)
  cosEvents.emit('lmstudio:modelLoaded', { modelId })

  return { success: true, modelId, ...response }
}

/**
 * Unload a model from LM Studio memory
 * @param {string} modelId - Model identifier to unload
 * @returns {Promise<Object>} - Unload result
 */
async function unloadModel(modelId) {
  const available = await checkLMStudioAvailable()
  if (!available) {
    return { success: false, error: 'LM Studio not available' }
  }

  const response = await lmStudioRequest('/api/v1/models/unload', {
    method: 'POST',
    body: JSON.stringify({ model: modelId }),
    timeout: 15000
  }).catch(err => ({ _err: err.message }))

  if (response._err) {
    console.error(`⚠️ Failed to unload model ${modelId}: ${response._err}`)
    return { success: false, error: response._err, modelId }
  }

  // Refresh loaded models
  await getLoadedModels(true)

  console.log(`📤 Model unloaded: ${modelId}`)
  cosEvents.emit('lmstudio:modelUnloaded', { modelId })

  return { success: true, modelId }
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

  // Auto-discover an embedding model if none specified
  let model = options.model
  if (!model) {
    const models = await getAvailableModels()
    const embeddingModel = models.find(m => m.type === 'embeddings' && m.state === 'loaded')
      || models.find(m => m.type === 'embeddings')
    if (embeddingModel) {
      // Load it if not already loaded
      if (embeddingModel.state !== 'loaded') {
        await loadModel(embeddingModel.id)
      }
      model = embeddingModel.id
    } else {
      return { success: false, error: 'No embedding model available in LM Studio' }
    }
  }

  const response = await lmStudioRequest('/v1/embeddings', {
    method: 'POST',
    body: JSON.stringify({ model, input: text }),
    timeout: options.timeout || 10000
  }).catch(err => ({ _err: err.message }))

  if (response._err) {
    return { success: false, error: response._err, model }
  }

  const embedding = response.data?.[0]?.embedding || []

  return {
    success: true,
    embedding,
    model,
    dimensions: embedding.length
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
