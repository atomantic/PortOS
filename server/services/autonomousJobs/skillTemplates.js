/**
 * Autonomous Jobs — skill templates and effective-prompt assembly.
 *
 * Reads/writes the per-job skill template markdown files, assembles a job's
 * effective prompt (skill template + briefing-config enrichments), and turns a
 * due job into a CoS task payload (`generateTaskFromJob`).
 */

import { writeFile } from 'fs/promises'
import { join } from 'path'
import { ensureDir, tryReadFile } from '../../lib/fileUtils.js'
import { JOBS_SKILLS_DIR, JOB_SKILL_MAP } from './constants.js'

/**
 * Load a job skill template from disk
 * @param {string} skillName - The skill template name (e.g., 'daily-briefing')
 * @returns {Promise<string|null>} Template content or null if not found
 */
async function loadJobSkillTemplate(skillName) {
  const filePath = join(JOBS_SKILLS_DIR, `${skillName}.md`)
  const content = await tryReadFile(filePath)
  if (content) {
    console.log(`🎯 Loaded job skill template: ${skillName}`)
  }
  return content
}

/**
 * Save a job skill template to disk
 * @param {string} skillName - The skill template name
 * @param {string} content - The template content
 */
async function saveJobSkillTemplate(skillName, content) {
  await ensureDir(JOBS_SKILLS_DIR)
  const filePath = join(JOBS_SKILLS_DIR, `${skillName}.md`)
  await writeFile(filePath, content)
  console.log(`💾 Saved job skill template: ${skillName}`)
}

/**
 * List all job skill templates
 * @returns {Promise<Array>} Array of { name, jobId, hasTemplate }
 */
async function listJobSkillTemplates() {
  const results = []
  for (const [jobId, skillName] of Object.entries(JOB_SKILL_MAP)) {
    const content = await loadJobSkillTemplate(skillName)
    results.push({
      name: skillName,
      jobId,
      hasTemplate: !!content
    })
  }
  return results
}

/**
 * Build additional prompt instructions based on daily briefing config options.
 * @param {Object} config - The briefing config object
 * @returns {string} Additional instructions to append, or empty string
 */
function buildBriefingConfigInstructions(config) {
  const parts = []

  if (config.dailyJoke) {
    parts.push('- Include a "Daily Joke" section with a short, clever joke to start the day on a light note.')
  }
  if (config.dailyQuote) {
    parts.push('- Include a "Daily Quote" section with an inspirational or thought-provoking quote relevant to the day\'s focus areas.')
  }
  if (config.dailyImage) {
    parts.push(
      '- Generate a "Daily Image" to accompany the briefing by calling POST /api/image-gen/generate with a creative prompt related to today\'s theme or focus areas. Use a cyberpunk or futuristic aesthetic. Include the resulting image path in the briefing. If the image gen API is unavailable (GET /api/image-gen/status returns connected: false), skip this section silently.'
    )
  }

  if (parts.length === 0) return ''
  return 'Optional enrichments (include these sections in the briefing):\n' + parts.join('\n')
}

/**
 * Append briefing config instructions to a prompt if this is the daily briefing job.
 */
function appendBriefingConfig(job, prompt) {
  if (job.id !== 'job-daily-briefing' || !job.config) return prompt
  const extras = buildBriefingConfigInstructions(job.config)
  return extras ? prompt + '\n\n' + extras : prompt
}

/**
 * Get the effective prompt for a job, using skill template if available
 * Extracts the prompt from the skill template's structured format
 * @param {Object} job - The job object
 * @returns {Promise<string>} The effective prompt template
 */
async function getJobEffectivePrompt(job) {
  const skillName = JOB_SKILL_MAP[job.id]
  if (!skillName) return appendBriefingConfig(job, job.promptTemplate)

  const template = await loadJobSkillTemplate(skillName)
  if (!template) return appendBriefingConfig(job, job.promptTemplate)

  // Extract structured sections from the skill template and build a prompt
  // The skill template has: Prompt Template header, Steps, Expected Outputs, Success Criteria
  const lines = template.split('\n')
  const sections = { prompt: '', steps: '', expectedOutputs: '', successCriteria: '' }
  let currentSection = null

  for (const line of lines) {
    if (line.startsWith('## Prompt Template')) { currentSection = 'prompt'; continue }
    if (line.startsWith('## Steps')) { currentSection = 'steps'; continue }
    if (line.startsWith('## Expected Outputs')) { currentSection = 'expectedOutputs'; continue }
    if (line.startsWith('## Success Criteria')) { currentSection = 'successCriteria'; continue }
    if (line.startsWith('## Job Metadata')) { currentSection = 'metadata'; continue }
    if (line.startsWith('# ')) { currentSection = null; continue }
    if (currentSection && currentSection !== 'metadata') {
      sections[currentSection] += line + '\n'
    }
  }

  // Build the effective prompt from structured sections
  let prompt = sections.prompt.trim()
  if (sections.steps.trim()) {
    prompt += '\n\nTasks to perform:\n' + sections.steps.trim()
  }

  prompt = appendBriefingConfig(job, prompt)

  if (sections.expectedOutputs.trim()) {
    prompt += '\n\nExpected outputs:\n' + sections.expectedOutputs.trim()
  }
  if (sections.successCriteria.trim()) {
    prompt += '\n\nSuccess criteria:\n' + sections.successCriteria.trim()
  }

  return prompt
}

/**
 * Generate a CoS task from a due job
 * @param {Object} job - The job to generate a task for
 * @returns {Promise<Object>} Task data suitable for cos.addTask()
 */
async function generateTaskFromJob(job) {
  const description = await getJobEffectivePrompt(job)
  const meta = job.taskMetadata || {}
  return {
    id: `${job.id}-${Date.now().toString(36)}`,
    description,
    priority: job.priority,
    metadata: {
      autonomousJob: true,
      jobId: job.id,
      jobName: job.name,
      jobCategory: job.category,
      autonomyLevel: job.autonomyLevel,
      // App-scoped jobs carry the target app id so prepareAgentWorkspace resolves
      // the agent's workspace to the app's repoPath. Absent = runs in PortOS root.
      ...(job.appId != null ? { app: job.appId } : {}),
      // Forward git-workflow options so an app-scoped task can isolate via a
      // worktree and open a PR (same metadata flags the built-in task types use).
      ...(meta.useWorktree != null ? { useWorktree: meta.useWorktree } : {}),
      ...(meta.openPR != null ? { openPR: meta.openPR } : {}),
      ...(meta.simplify != null ? { simplify: meta.simplify } : {}),
      // Optional per-job AI provider + model override. resolveAgentProviderAndModel
      // reads metadata.provider to switch providers and selectModelForTask reads
      // metadata.model as the highest-priority model choice. Absent = active
      // provider / per-task model selection (historical behavior).
      ...(job.providerId ? { provider: job.providerId } : {}),
      ...(job.model ? { model: job.model } : {}),
      // Reasoning-effort override — agentLifecycle reads metadata.effort and the
      // spawn builders emit `--effort`/`-c model_reasoning_effort=` (no-op for
      // non-effort providers). Absent = provider default.
      ...(job.effort ? { effort: job.effort } : {})
    },
    taskType: 'internal',
    autoApprove: job.autonomyLevel === 'yolo'
  }
}

export {
  loadJobSkillTemplate,
  saveJobSkillTemplate,
  listJobSkillTemplates,
  buildBriefingConfigInstructions,
  appendBriefingConfig,
  getJobEffectivePrompt,
  generateTaskFromJob
}
