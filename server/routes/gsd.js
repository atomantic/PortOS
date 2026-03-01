/**
 * GSD (Get Stuff Done) API Routes
 *
 * Mounted at /api/cos/gsd
 * Provides endpoints for scanning, analyzing, and acting on GSD project state.
 */

import { Router } from 'express'
import { z } from 'zod'
import { existsSync } from 'fs'
import { readFile, writeFile } from 'fs/promises'
import { join, resolve } from 'path'
import { asyncHandler, ServerError } from '../lib/errorHandler.js'
import * as gsdService from '../services/gsdService.js'
import { addTask } from '../services/cos.js'
import { getActiveApps } from '../services/apps.js'
import * as git from '../services/git.js'

const router = Router()

// Validation schemas
const concernIdsSchema = z.object({
  concernIds: z.array(z.string()).optional(),
  all: z.boolean().optional()
}).refine(data => data.all || (data.concernIds && data.concernIds.length > 0), {
  message: 'Either concernIds or all:true is required'
})

const phaseActionSchema = z.object({
  action: z.enum(['plan', 'execute', 'verify'])
})

const documentUpdateSchema = z.object({
  content: z.string(),
  commitMessage: z.string().optional()
})

const GSD_ALLOWED_DOCUMENTS = ['PROJECT.md', 'ROADMAP.md', 'STATE.md', 'CONCERNS.md', 'RETROSPECTIVE.md', 'MILESTONES.md']

const GSD_ACTION_DESCRIPTIONS = {
  plan: (phaseId) => `Run /gsd:plan-phase to create a detailed plan for phase ${phaseId}`,
  execute: (phaseId) => `Run /gsd:execute-phase to execute phase ${phaseId}`,
  verify: (phaseId) => `Run /gsd:verify-work to verify phase ${phaseId} implementation`
}

/**
 * Load app and resolve .planning path, attach to req
 */
async function loadAppPlanning(req) {
  const apps = await getActiveApps()
  const app = apps.find(a => a.id === req.params.appId)
  if (!app?.repoPath) return null
  const planningPath = join(app.repoPath, '.planning')
  if (!existsSync(planningPath)) return null
  return { app, planningPath }
}


// GET /projects — list GSD-enabled projects
router.get('/projects', asyncHandler(async (req, res) => {
  const projects = await gsdService.scanForGsdProjects()
  res.json({ projects })
}))

// GET /projects/:appId — project detail
router.get('/projects/:appId', asyncHandler(async (req, res) => {
  const project = await gsdService.getGsdProject(req.params.appId)
  if (!project) {
    throw new ServerError('GSD project not found', { status: 404, code: 'GSD_PROJECT_NOT_FOUND' })
  }
  res.json(project)
}))

// GET /projects/:appId/concerns — parsed CONCERNS.md with severity
router.get('/projects/:appId/concerns', asyncHandler(async (req, res) => {
  const project = await gsdService.getGsdProject(req.params.appId)
  if (!project) {
    throw new ServerError('GSD project not found', { status: 404, code: 'GSD_PROJECT_NOT_FOUND' })
  }
  res.json({ concerns: project.concerns })
}))

// GET /projects/:appId/phases — phase list with status
router.get('/projects/:appId/phases', asyncHandler(async (req, res) => {
  const project = await gsdService.getGsdProject(req.params.appId)
  if (!project) {
    throw new ServerError('GSD project not found', { status: 404, code: 'GSD_PROJECT_NOT_FOUND' })
  }
  const pendingActions = await gsdService.getGsdPendingActions(req.params.appId)
  res.json({ phases: project.phases, pendingActions })
}))

// GET /projects/:appId/phases/:phaseId — phase detail
router.get('/projects/:appId/phases/:phaseId', asyncHandler(async (req, res) => {
  const project = await gsdService.getGsdProject(req.params.appId)
  if (!project) {
    throw new ServerError('GSD project not found', { status: 404, code: 'GSD_PROJECT_NOT_FOUND' })
  }
  const phase = project.phases.find(p => p.id === req.params.phaseId)
  if (!phase) {
    throw new ServerError('Phase not found', { status: 404, code: 'GSD_PHASE_NOT_FOUND' })
  }
  res.json(phase)
}))

// POST /projects/:appId/concerns/tasks — create CoS tasks from selected concerns
router.post('/projects/:appId/concerns/tasks', asyncHandler(async (req, res) => {
  const body = concernIdsSchema.parse(req.body)
  const allTasks = await gsdService.generateConcernTasks(req.params.appId)

  if (allTasks.length === 0) {
    throw new ServerError('No concerns found for this project', { status: 404, code: 'NO_CONCERNS' })
  }

  const tasksToCreate = body.all
    ? allTasks
    : allTasks.filter(t => body.concernIds.includes(t.metadata.gsdConcern))

  const created = []
  for (const task of tasksToCreate) {
    const result = await addTask(task, 'internal')
    created.push(result)
  }

  console.log(`📋 Created ${created.length} CoS tasks from GSD concerns for ${req.params.appId}`)
  res.json({ created: created.length, tasks: created })
}))

// POST /projects/:appId/phases/:phaseId/action — trigger plan/execute/verify as CoS task
router.post('/projects/:appId/phases/:phaseId/action', asyncHandler(async (req, res) => {
  const { action } = phaseActionSchema.parse(req.body)
  const { appId, phaseId } = req.params

  const project = await gsdService.getGsdProject(appId)
  if (!project) {
    throw new ServerError('GSD project not found', { status: 404, code: 'GSD_PROJECT_NOT_FOUND' })
  }

  const phase = project.phases.find(p => p.id === phaseId)
  if (!phase) {
    throw new ServerError('Phase not found', { status: 404, code: 'GSD_PHASE_NOT_FOUND' })
  }

  const description = GSD_ACTION_DESCRIPTIONS[action](phaseId)
  const result = await addTask({
    description,
    app: appId,
    priority: 'MEDIUM',
    metadata: { gsdPhase: phaseId, gsdAction: action }
  }, 'internal')

  console.log(`🎯 GSD ${action} task created for ${appId} phase ${phaseId}`)
  res.json({ success: true, task: result })
}))

// GET /projects/:appId/documents/:docName — read a .planning/ document
router.get('/projects/:appId/documents/:docName', asyncHandler(async (req, res) => {
  const { docName } = req.params
  if (!GSD_ALLOWED_DOCUMENTS.includes(docName)) {
    throw new ServerError('Document not in allowlist', { status: 400, code: 'INVALID_DOCUMENT' })
  }

  const ctx = await loadAppPlanning(req)
  if (!ctx) {
    throw new ServerError('GSD project not found', { status: 404, code: 'GSD_PROJECT_NOT_FOUND' })
  }

  const filePath = join(ctx.planningPath, docName)
  const resolved = resolve(filePath)
  if (!resolved.startsWith(resolve(ctx.planningPath))) {
    throw new ServerError('Invalid document path', { status: 400, code: 'PATH_TRAVERSAL' })
  }

  if (!existsSync(resolved)) {
    throw new ServerError('Document not found', { status: 404, code: 'NOT_FOUND' })
  }

  const content = await readFile(resolved, 'utf-8')
  res.json({ filename: docName, content })
}))

// PUT /projects/:appId/documents/:docName — save and git commit a .planning/ document
router.put('/projects/:appId/documents/:docName', asyncHandler(async (req, res) => {
  const { docName } = req.params
  if (!GSD_ALLOWED_DOCUMENTS.includes(docName)) {
    throw new ServerError('Document not in allowlist', { status: 400, code: 'INVALID_DOCUMENT' })
  }

  const ctx = await loadAppPlanning(req)
  if (!ctx) {
    throw new ServerError('GSD project not found', { status: 404, code: 'GSD_PROJECT_NOT_FOUND' })
  }

  const filePath = join(ctx.planningPath, docName)
  const resolved = resolve(filePath)
  if (!resolved.startsWith(resolve(ctx.planningPath))) {
    throw new ServerError('Invalid document path', { status: 400, code: 'PATH_TRAVERSAL' })
  }

  const { content, commitMessage } = documentUpdateSchema.parse(req.body)
  const created = !existsSync(resolved)

  await writeFile(resolved, content, 'utf-8')
  const relPath = `.planning/${docName}`
  await git.stageFiles(ctx.app.repoPath, [relPath])

  const status = await git.getStatus(ctx.app.repoPath)
  if (status.clean) {
    return res.json({ success: true, noChanges: true })
  }

  const message = commitMessage || `docs: update .planning/${docName} via PortOS`
  const result = await git.commit(ctx.app.repoPath, message)
  console.log(`📝 ${created ? 'Created' : 'Updated'} .planning/${docName} in ${ctx.app.name} (${result.hash})`)

  res.json({ success: true, hash: result.hash, created })
}))

export default router
