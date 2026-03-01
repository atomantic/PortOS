/**
 * GSD (Get Stuff Done) Scanner Service
 *
 * Scans managed apps for .planning/ directories and parses GSD project state.
 * Provides concern analysis and phase tracking for the Chief of Staff GSD integration.
 */

import { readFile, readdir, stat } from 'fs/promises'
import { join } from 'path'
import { createHash } from 'crypto'
import { getActiveApps } from './apps.js'

// 30-second TTL cache per app
const projectCache = new Map()
const CACHE_TTL = 30000

function getCached(key) {
  const entry = projectCache.get(key)
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.data
  return null
}
function setCache(key, data) {
  projectCache.set(key, { data, ts: Date.now() })
}

// Severity mapping for CONCERNS.md sections
const SEVERITY_MAP = {
  'security considerations': 'CRITICAL',
  'known bugs': 'HIGH',
  'missing critical features': 'HIGH',
  'tech debt': 'MEDIUM',
  'performance': 'MEDIUM',
  'fragile areas': 'MEDIUM',
  'test coverage': 'MEDIUM',
  'dependencies at risk': 'LOW',
  'scaling limits': 'LOW'
}

/**
 * Generate a deterministic hash ID from section title and item text
 */
function hashId(section, text) {
  return createHash('md5').update(`${section}:${text}`).digest('hex').slice(0, 12)
}

/**
 * Safely read a file, returning null if it doesn't exist
 */
async function safeReadFile(filePath) {
  const content = await readFile(filePath, 'utf-8').catch(err => {
    if (err.code === 'ENOENT') return null
    throw err
  })
  return content
}

/**
 * Safely stat a path, returning null if it doesn't exist
 */
async function safeStat(path) {
  return stat(path).catch(err => {
    if (err.code === 'ENOENT') return null
    throw err
  })
}

/**
 * Scan all active apps for .planning/ directories
 * Returns array of project summaries
 */
export async function scanForGsdProjects() {
  const apps = await getActiveApps()
  const projects = []

  for (const app of apps) {
    if (!app.repoPath) continue
    const planningPath = join(app.repoPath, '.planning')
    const planningInfo = await safeStat(planningPath)

    if (planningInfo?.isDirectory()) {
      const roadmapInfo = await safeStat(join(planningPath, 'ROADMAP.md'))
      const stateInfo = await safeStat(join(planningPath, 'STATE.md'))
      const concernsInfo = await safeStat(join(planningPath, 'CONCERNS.md'))

      projects.push({
        appId: app.id,
        appName: app.name,
        repoPath: app.repoPath,
        planningPath,
        hasRoadmap: !!roadmapInfo,
        hasState: !!stateInfo,
        hasConcerns: !!concernsInfo
      })
    }
  }

  console.log(`📋 GSD scan found ${projects.length} projects with .planning/`)
  return projects
}

/**
 * Parse ROADMAP.md to extract milestone table rows
 */
export async function parseRoadmapMd(filePath) {
  const content = await safeReadFile(filePath)
  if (!content) return null

  const milestones = []
  const lines = content.split('\n')

  for (const line of lines) {
    if (!line.startsWith('|')) continue
    // Skip header separator rows (e.g., |---|---|---|)
    if (/^\|[\s-]+\|/.test(line) && !line.match(/[a-zA-Z0-9]/)) continue
    // Skip header rows
    if (line.toLowerCase().includes('phase') && line.toLowerCase().includes('title')) continue

    const cells = line.split('|').map(c => c.trim()).filter(Boolean)
    if (cells.length >= 3) {
      milestones.push({
        phase: cells[0],
        title: cells[1],
        status: cells[2]
      })
    }
  }

  return { milestones, raw: content }
}

/**
 * Parse STATE.md to extract YAML frontmatter
 */
export async function parseStateMd(filePath) {
  const content = await safeReadFile(filePath)
  if (!content) return null

  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/)
  if (!frontmatterMatch) return { frontmatter: {}, raw: content }

  const frontmatter = {}
  const lines = frontmatterMatch[1].split('\n')
  for (const line of lines) {
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    const value = line.slice(colonIdx + 1).trim()
    if (key) frontmatter[key] = value
  }

  return { frontmatter, raw: content }
}

/**
 * Parse CONCERNS.md to extract sections with severity
 */
export async function parseConcernsMd(filePath) {
  const content = await safeReadFile(filePath)
  if (!content) return null

  const sections = []
  let currentSection = null
  const lines = content.split('\n')

  for (const line of lines) {
    const headerMatch = line.match(/^##\s+(.+)/)
    if (headerMatch) {
      currentSection = {
        title: headerMatch[1].trim(),
        severity: 'MEDIUM',
        items: []
      }
      // Map severity based on section title
      const lowerTitle = currentSection.title.toLowerCase()
      for (const [pattern, severity] of Object.entries(SEVERITY_MAP)) {
        if (lowerTitle.includes(pattern)) {
          currentSection.severity = severity
          break
        }
      }
      sections.push(currentSection)
      continue
    }

    if (currentSection) {
      const itemMatch = line.match(/^-\s+(.+)/)
      if (itemMatch) {
        const text = itemMatch[1].trim()
        currentSection.items.push({
          id: hashId(currentSection.title, text),
          text
        })
      }
    }
  }

  return { sections }
}

/**
 * Parse a single PLAN.md file content into frontmatter + tasks
 */
function parsePlanContent(content) {
  const frontmatter = {}
  let bodyContent = content

  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/)
  if (frontmatterMatch) {
    const fmLines = frontmatterMatch[1].split('\n')
    for (const line of fmLines) {
      const colonIdx = line.indexOf(':')
      if (colonIdx === -1) continue
      const key = line.slice(0, colonIdx).trim()
      const value = line.slice(colonIdx + 1).trim()
      if (key) frontmatter[key] = value
    }
    bodyContent = content.slice(frontmatterMatch[0].length)
  }

  const tasks = []
  for (const line of bodyContent.split('\n')) {
    const taskMatch = line.match(/^[-*]\s+\[([ xX])\]\s+(.+)/)
    if (taskMatch) {
      tasks.push({
        completed: taskMatch[1].toLowerCase() === 'x',
        text: taskMatch[2].trim()
      })
    }
  }

  return { frontmatter, tasks, raw: content }
}

/**
 * Scan phase directory for *-PLAN.md files (e.g. 01-01-PLAN.md, 03-02-PLAN.md)
 * Returns array of sub-plans sorted by filename
 */
export async function parsePhasePlans(phasePath) {
  const entries = await readdir(phasePath).catch(() => [])
  const planFiles = entries.filter(f => f.endsWith('-PLAN.md')).sort()
  if (planFiles.length === 0) return []

  const plans = []
  for (const filename of planFiles) {
    const content = await safeReadFile(join(phasePath, filename))
    if (!content) continue
    plans.push({ filename, ...parsePlanContent(content) })
  }
  return plans
}

/**
 * Parse SUMMARY.md files in a phase directory
 */
export async function parsePhaseSummaries(phasePath) {
  const entries = await readdir(phasePath).catch(() => [])
  const summaryFiles = entries.filter(f => f.endsWith('-SUMMARY.md')).sort()
  if (summaryFiles.length === 0) return []

  const summaries = []
  for (const filename of summaryFiles) {
    const content = await safeReadFile(join(phasePath, filename))
    if (!content) continue
    summaries.push({ filename, ...parsePlanContent(content) })
  }
  return summaries
}

/**
 * Scan phase directory for *-VERIFICATION.md (e.g. 01-VERIFICATION.md)
 */
export async function parseVerification(phasePath) {
  const entries = await readdir(phasePath).catch(() => [])
  const verifyFile = entries.find(f => f.endsWith('-VERIFICATION.md'))
  if (!verifyFile) return null

  const content = await safeReadFile(join(phasePath, verifyFile))
  if (!content) return null

  let status = 'unknown'
  let score = null

  const statusMatch = content.match(/status:\s*(\w+)/i)
  if (statusMatch) status = statusMatch[1].toLowerCase()

  const scoreMatch = content.match(/score:\s*([\d.]+)/i)
  if (scoreMatch) score = parseFloat(scoreMatch[1])

  return { status, score, raw: content }
}

/**
 * Scan phase directory for *-RESEARCH.md (e.g. 01-RESEARCH.md)
 */
export async function parsePhaseResearch(phasePath) {
  const entries = await readdir(phasePath).catch(() => [])
  const researchFile = entries.find(f => f.endsWith('-RESEARCH.md'))
  if (!researchFile) return null

  const content = await safeReadFile(join(phasePath, researchFile))
  if (!content) return null
  return { filename: researchFile, raw: content }
}

/**
 * Get full GSD project state for a single app
 */
export async function getGsdProject(appIdOrPath) {
  const cached = getCached(`project:${appIdOrPath}`)
  if (cached) return cached

  const apps = await getActiveApps()
  const app = apps.find(a => a.id === appIdOrPath || a.repoPath === appIdOrPath)
  if (!app) return null

  const planningPath = join(app.repoPath, '.planning')
  const planningInfo = await safeStat(planningPath)
  if (!planningInfo?.isDirectory()) return null

  const roadmap = await parseRoadmapMd(join(planningPath, 'ROADMAP.md'))
  const state = await parseStateMd(join(planningPath, 'STATE.md'))
  const concerns = await parseConcernsMd(join(planningPath, 'CONCERNS.md'))
  const projectDoc = await safeReadFile(join(planningPath, 'PROJECT.md'))

  // Scan for phase directories
  const phases = []
  const phasesDir = join(planningPath, 'phases')
  const phasesDirInfo = await safeStat(phasesDir)
  if (phasesDirInfo?.isDirectory()) {
    const entries = await readdir(phasesDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const phasePath = join(phasesDir, entry.name)
      const plans = await parsePhasePlans(phasePath)
      const summaries = await parsePhaseSummaries(phasePath)
      const verification = await parseVerification(phasePath)
      const research = await parsePhaseResearch(phasePath)
      const totalTasks = plans.reduce((sum, p) => sum + p.tasks.length, 0)
      const completedTasks = plans.reduce((sum, p) => sum + p.tasks.filter(t => t.completed).length, 0)
      phases.push({
        id: entry.name,
        plans,
        summaries,
        verification,
        research,
        totalTasks,
        completedTasks
      })
    }
    phases.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
  }

  // Read config if present
  const configContent = await safeReadFile(join(planningPath, 'config.json'))
  const config = configContent ? JSON.parse(configContent) : null

  const result = {
    app: { id: app.id, name: app.name, repoPath: app.repoPath },
    roadmap,
    state,
    concerns,
    projectDoc: projectDoc ? { raw: projectDoc } : null,
    phases,
    config
  }

  setCache(`project:${appIdOrPath}`, result)
  return result
}

/**
 * Analyze project state to find phases ready to advance
 */
export async function getGsdPendingActions(appId) {
  const project = await getGsdProject(appId)
  if (!project) return []

  const actions = []
  const currentPhase = project.state?.frontmatter?.current_phase

  for (const phase of project.phases) {
    const hasPlans = phase.plans?.length > 0
    const hasVerification = !!phase.verification
    const allTasksComplete = phase.totalTasks > 0 && phase.completedTasks === phase.totalTasks
    const verificationPassed = phase.verification?.status === 'passed'

    let nextAction = null
    if (!hasPlans) {
      nextAction = 'plan'
    } else if (!allTasksComplete) {
      nextAction = 'execute'
    } else if (!hasVerification || !verificationPassed) {
      nextAction = 'verify'
    }

    if (nextAction) {
      actions.push({
        phaseId: phase.id,
        currentStep: hasPlans ? (allTasksComplete ? 'executed' : 'planned') : 'unplanned',
        nextAction
      })
    }
  }

  return actions
}

/**
 * Generate CoS task objects from CONCERNS.md items
 */
export async function generateConcernTasks(appId) {
  const project = await getGsdProject(appId)
  if (!project?.concerns) return []

  const tasks = []
  for (const section of project.concerns.sections) {
    for (const item of section.items) {
      tasks.push({
        id: `gsd-concern-${item.id}`,
        description: `[GSD:Concern] ${section.title}: ${item.text}`,
        priority: section.severity === 'CRITICAL' ? 'HIGH' : section.severity,
        metadata: {
          gsdConcern: item.id,
          gsdSourceFile: 'CONCERNS.md',
          gsdSection: section.title,
          gsdSeverity: section.severity,
          app: project.app.id
        },
        taskType: 'internal'
      })
    }
  }

  return tasks
}

