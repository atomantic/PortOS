/**
 * Autonomous Jobs — persistence and one-time init.
 *
 * Owns the read/write of autonomous-jobs.json: `initJobs` runs the one-time
 * migration + default merge at startup (guarded by `initPromise`), `loadJobs`
 * is the read path used everywhere else, and `saveJobs` is the write path.
 * Also seeds/updates the job skill templates and migrates the legacy
 * scripts-state.json into jobs.
 */

import { writeFile, rename, readdir } from 'fs/promises'
import { join } from 'path'
import { existsSync } from 'fs'
import { ensureDir, PATHS, readJSONFile, atomicWrite, tryReadFile } from '../../lib/fileUtils.js'
import { validateCommand } from '../../lib/commandSecurity.js'
import { DATA_DIR, JOBS_FILE, JOBS_SKILLS_DIR, resolveIntervalMs } from './constants.js'
import { createDefaultJobsData, mergeWithDefaults } from './defaults.js'

let initPromise = null

/**
 * Initialize jobs — called once at startup. Handles migration and default merging.
 * Guarded by initPromise to prevent concurrent init from parallel requests.
 */
async function initJobs() {
  await ensureDir(DATA_DIR)
  await syncSkillTemplatesFromSample()

  const loaded = await readJSONFile(JOBS_FILE, null)
  if (!loaded) {
    const initial = createDefaultJobsData()
    await migrateScriptsState(initial)
    await saveJobs(initial)
    return initial
  }

  const { data: merged, dirty } = mergeWithDefaults(loaded)
  const migrated = await migrateScriptsState(merged)
  if (migrated || dirty) {
    await saveJobs(merged)
  }
  return merged
}

async function syncSkillTemplatesFromSample() {
  if (!PATHS.root) return
  const sampleDir = join(PATHS.root, 'data.reference', 'prompts', 'skills', 'jobs')
  if (!existsSync(sampleDir)) return
  await ensureDir(JOBS_SKILLS_DIR)
  const shippedDir = join(JOBS_SKILLS_DIR, '.shipped')
  await ensureDir(shippedDir)
  const files = await readdir(sampleDir).catch(() => [])
  for (const file of files) {
    if (!file.endsWith('.md')) continue
    const destPath = join(JOBS_SKILLS_DIR, file)
    const shippedPath = join(shippedDir, file)
    const sampleContent = await tryReadFile(join(sampleDir, file))
    if (!sampleContent) continue
    const existingContent = await tryReadFile(destPath)
    if (!existingContent) {
      // Case a: fresh install — seed file and record shipped snapshot
      await writeFile(destPath, sampleContent)
      await writeFile(shippedPath, sampleContent)
      console.log(`📝 Seeded missing skill template: ${file}`)
      continue
    }
    if (existingContent === sampleContent) {
      // Case b: file already matches sample — ensure .shipped is current
      const shippedContent = await tryReadFile(shippedPath)
      if (shippedContent !== sampleContent) await writeFile(shippedPath, sampleContent)
      continue
    }
    const shippedContent = await tryReadFile(shippedPath)
    if (existingContent === shippedContent) {
      // Case c: file matches last-shipped snapshot but sample has changed — safe to update
      await writeFile(destPath, sampleContent)
      await writeFile(shippedPath, sampleContent)
      console.log(`🔄 Updated unmodified skill template: ${file}`)
    } else {
      // Case d: for installs upgrading from a pre-.shipped release, any existing
      // skill file that doesn't match the current sample lands here. In reality
      // the file might just be the previous shipped version — we can't tell without
      // history. We choose preservation: the user's file (whether intentional
      // customization or a stale shipped copy) stays in place. Users who want the
      // new template can delete the file and restart so the seeder re-creates it
      // from data.reference/.
      console.log(`ℹ️ Preserving user-modified skill template: ${file}`)
    }
  }
}

/**
 * Load jobs from disk. On first call, runs one-time init (migration + defaults).
 * Subsequent calls are read-only with in-memory default merging.
 * @returns {Promise<Object>} Jobs data
 */
async function loadJobs() {
  if (!initPromise) {
    initPromise = initJobs()
  }
  await initPromise
  const loaded = await readJSONFile(JOBS_FILE, null)
  if (!loaded) return createDefaultJobsData()
  const { data } = mergeWithDefaults(loaded)
  return data
}

/**
 * Migrate scripts-state.json entries into jobs (one-time migration)
 */
async function migrateScriptsState(jobsData) {
  const scriptsFile = join(DATA_DIR, 'scripts-state.json')
  const raw = await tryReadFile(scriptsFile)
  if (!raw) return false

  let scriptsState
  try {
    scriptsState = JSON.parse(raw)
  } catch (err) {
    console.warn(`⚠️ scripts-state.json is corrupted, skipping migration: ${err.message}`)
    const failedSuffix = `.failed-${Date.now()}`
    await rename(scriptsFile, scriptsFile + failedSuffix)
    return false
  }
  const scripts = scriptsState.scripts ? Object.values(scriptsState.scripts) : []
  if (scripts.length === 0) {
    const migrateSuffix = `.migrated-${Date.now()}`
    await rename(scriptsFile, scriptsFile + migrateSuffix)
    return false
  }

  const now = new Date().toISOString()
  const existingIds = new Set(jobsData.jobs.map(j => j.id))

  // Map legacy schedule values to valid interval values
  const VALID_INTERVALS = new Set(['hourly', 'every-2-hours', 'every-4-hours', 'every-8-hours', 'daily', 'weekly', 'biweekly', 'monthly', 'custom'])
  const LEGACY_SCHEDULE_MAP = {
    'every-5-min': 'hourly',
    'every-10-min': 'hourly',
    'every-15-min': 'hourly',
    'every-30-min': 'hourly',
    'every-hour': 'hourly',
    'every-3-hours': 'every-4-hours',
    'every-6-hours': 'every-8-hours',
    'every-12-hours': 'daily',
    'twice-daily': 'daily'
  }
  const mapLegacySchedule = (schedule, scriptName) => {
    if (!schedule || schedule === 'on-demand' || schedule === 'startup') return 'daily'
    if (VALID_INTERVALS.has(schedule)) return schedule
    if (LEGACY_SCHEDULE_MAP[schedule]) {
      console.log(`📦 Mapped legacy schedule '${schedule}' for '${scriptName}' to '${LEGACY_SCHEDULE_MAP[schedule]}'`)
      return LEGACY_SCHEDULE_MAP[schedule]
    }
    console.warn(`⚠️ Legacy schedule '${schedule}' for script '${scriptName}' not recognized, defaulting to 'daily'`)
    return 'daily'
  }

  const existingNames = new Set(jobsData.jobs.map(j => j.name.toLowerCase()))

  for (const script of scripts) {
    const jobId = `job-migrated-${script.id}`
    if (existingIds.has(jobId)) continue
    if (existingNames.has(script.name.toLowerCase())) continue

    const mappedInterval = mapLegacySchedule(script.schedule, script.name)
    if (script.cronExpression) {
      console.warn(`⚠️ Legacy cron expression '${script.cronExpression}' for script '${script.name}' not supported by job scheduler, using interval '${mappedInterval}' instead`)
    }
    const isOnDemandOrStartup = script.schedule === 'on-demand' || script.schedule === 'startup'

    // Validate command against allowlist — disable jobs with invalid commands
    let commandValid = true
    if (script.command) {
      const cmdValidation = validateCommand(script.command)
      if (!cmdValidation.valid) {
        console.warn(`⚠️ Migrated script '${script.name}' has invalid command, disabling: ${cmdValidation.error}`)
        commandValid = false
      }
    }

    jobsData.jobs.push({
      id: jobId,
      name: script.name,
      description: script.description || '',
      category: 'migrated-script',
      type: 'shell',
      command: commandValid ? script.command : null,
      interval: mappedInterval,
      intervalMs: resolveIntervalMs(mappedInterval),
      enabled: commandValid ? (isOnDemandOrStartup ? false : (script.enabled || false)) : false,
      priority: script.triggerPriority || 'MEDIUM',
      triggerAction: 'log-only',
      lastRun: script.lastRun || null,
      runCount: script.runCount || 0,
      createdAt: script.createdAt || now,
      updatedAt: now
    })
  }

  await saveJobs(jobsData)
  const migrateSuffix = `.migrated-${Date.now()}`
  await rename(scriptsFile, scriptsFile + migrateSuffix)
  console.log(`📦 Migrated ${scripts.length} scripts to jobs`)
  return true
}

/**
 * Save jobs to disk
 */
async function saveJobs(data) {
  await ensureDir(DATA_DIR)
  data.lastUpdated = new Date().toISOString()
  await atomicWrite(JOBS_FILE, data)
}

export { initJobs, syncSkillTemplatesFromSample, loadJobs, migrateScriptsState, saveJobs }
