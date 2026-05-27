import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock modules before import
vi.mock('./cosEvents.js', () => ({
  cosEvents: { emit: vi.fn() }
}))

vi.mock('../lib/fileUtils.js', () => ({
tryReadFile: vi.fn().mockResolvedValue(null),
  readJSONFile: vi.fn(),
  ensureDir: vi.fn().mockResolvedValue(),
  atomicWrite: vi.fn().mockResolvedValue(),
  safeJSONParse: (raw, fallback) => { try { return JSON.parse(raw) } catch { return fallback } },
  PATHS: { cos: '/mock/data/cos', digitalTwin: '/mock/data/digital-twin', data: '/mock/data', root: '/mock/root' },
  HOUR: 60 * 60 * 1000,
  DAY: 24 * 60 * 60 * 1000
}))

vi.mock('fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(),
  readFile: vi.fn().mockResolvedValue('{}'),
  rename: vi.fn().mockResolvedValue(),
  readdir: vi.fn().mockResolvedValue([]),
  stat: vi.fn().mockResolvedValue({ isDirectory: () => false, mtimeMs: 0 }),
  rm: vi.fn().mockResolvedValue()
}))

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(false)
}))

vi.mock('./worktreeManager.js', () => ({
  reapMergedWorktrees: vi.fn().mockResolvedValue({ reaped: [] }),
  cleanupOrphanedWorktrees: vi.fn().mockResolvedValue(0)
}))

vi.mock('./agentState.js', () => ({
  getActiveAgentIds: vi.fn().mockReturnValue([])
}))

vi.mock('./autobiography.js', () => ({
  checkAndPrompt: vi.fn().mockResolvedValue({ prompted: true, prompt: { id: 'test-1', text: 'test' } })
}))

// Import after mocks
import {
  agentDataCleanup,
  getAllJobs,
  getJob,
  getDueJobs,
  createJob,
  updateJob,
  deleteJob,
  recordJobExecution,
  toggleJob,
  generateTaskFromJob,
  getJobStats,
  INTERVAL_OPTIONS,
  isScriptJob,
  executeScriptJob,
  initJobs
} from './autonomousJobs.js'
import { readJSONFile, atomicWrite } from '../lib/fileUtils.js'
import { cosEvents } from './cosEvents.js'
import { checkAndPrompt } from './autobiography.js'
import { reapMergedWorktrees, cleanupOrphanedWorktrees } from './worktreeManager.js'
import { getActiveAgentIds } from './agentState.js'

describe('autonomousJobs', () => {
  const mockJobsData = {
    version: 1,
    lastUpdated: '2025-01-01T00:00:00.000Z',
    jobs: [
      {
        id: 'job-test-1',
        name: 'Test Job',
        description: 'A test job',
        category: 'test',
        interval: 'daily',
        intervalMs: 86400000,
        enabled: true,
        priority: 'MEDIUM',
        autonomyLevel: 'manager',
        promptTemplate: 'Do the test thing',
        lastRun: null,
        runCount: 0,
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z'
      }
    ]
  }

  beforeEach(() => {
    vi.clearAllMocks()
    readJSONFile.mockResolvedValue(JSON.parse(JSON.stringify(mockJobsData)))
  })

  describe('getDueJobs', () => {
    it('never-run enabled job is always due', async () => {
      const due = await getDueJobs()

      const testJob = due.find(j => j.id === 'job-test-1')
      expect(testJob).toBeDefined()
      expect(testJob.reason).toBe('never-run')
      expect(testJob.overdueBy).toBeGreaterThan(0)
    })

    it('recently-run job is NOT due', async () => {
      const now = new Date()
      const oneHourAgo = new Date(now - 60 * 60 * 1000).toISOString()

      readJSONFile.mockResolvedValue({
        ...mockJobsData,
        jobs: [{
          ...mockJobsData.jobs[0],
          lastRun: oneHourAgo
        }]
      })

      const due = await getDueJobs()

      expect(due.find(j => j.id === 'job-test-1')).toBeUndefined()
    })

    it('jobs sort by most overdue first', async () => {
      const now = new Date()
      const twoDaysAgo = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString()
      const fourDaysAgo = new Date(now - 4 * 24 * 60 * 60 * 1000).toISOString()

      readJSONFile.mockResolvedValue({
        ...mockJobsData,
        jobs: [
          {
            ...mockJobsData.jobs[0],
            id: 'job-1',
            name: 'Less Overdue',
            lastRun: twoDaysAgo,
            intervalMs: 86400000
          },
          {
            ...mockJobsData.jobs[0],
            id: 'job-2',
            name: 'More Overdue',
            lastRun: fourDaysAgo,
            intervalMs: 86400000
          }
        ]
      })

      const due = await getDueJobs()

      // Verify relative ordering: more overdue jobs should come first
      const job2Idx = due.findIndex(j => j.id === 'job-2')
      const job1Idx = due.findIndex(j => j.id === 'job-1')
      expect(job2Idx).toBeGreaterThanOrEqual(0)
      expect(job1Idx).toBeGreaterThanOrEqual(0)
      expect(job2Idx).toBeLessThan(job1Idx)
      expect(due[job2Idx].overdueBy).toBeGreaterThan(due[job1Idx].overdueBy)

      // Verify only expected test jobs plus any default jobs are present
      const testJobIds = new Set(['job-test-1', 'job-1', 'job-2'])
      const defaultJobPrefixes = ['job-github-', 'job-brain-', 'job-daily-', 'job-moltworld-', 'job-jira-', 'job-autobiography-', 'job-system-', 'job-agent-', 'job-datadog-']
      const unexpectedJobs = due.filter(j => !testJobIds.has(j.id) && !defaultJobPrefixes.some(p => j.id.startsWith(p)))
      expect(unexpectedJobs).toHaveLength(0)
    })
  })

  describe('generateTaskFromJob', () => {
    it('returns correct task structure with metadata', async () => {
      const job = mockJobsData.jobs[0]
      const task = await generateTaskFromJob(job)

      expect(task).toMatchObject({
        priority: job.priority,
        metadata: {
          autonomousJob: true,
          jobId: job.id,
          jobName: job.name,
          jobCategory: job.category,
          autonomyLevel: job.autonomyLevel
        },
        taskType: 'internal',
        autoApprove: false
      })
      expect(task.id).toContain(job.id)
      expect(task.description).toBeTruthy()
    })

    it('autoApprove true when autonomyLevel is yolo', async () => {
      const yoloJob = {
        ...mockJobsData.jobs[0],
        autonomyLevel: 'yolo'
      }

      const task = await generateTaskFromJob(yoloJob)

      expect(task.autoApprove).toBe(true)
      expect(task.metadata.autonomyLevel).toBe('yolo')
    })
  })

  describe('createJob with resolveIntervalMs', () => {
    it('hourly interval produces correct intervalMs', async () => {
      const jobData = {
        name: 'Hourly Job',
        interval: 'hourly',
        promptTemplate: 'Do hourly thing'
      }

      const job = await createJob(jobData)

      expect(job.intervalMs).toBe(60 * 60 * 1000)
      expect(job.interval).toBe('hourly')
    })

    it('daily interval produces correct intervalMs', async () => {
      const jobData = {
        name: 'Daily Job',
        interval: 'daily',
        promptTemplate: 'Do daily thing'
      }

      const job = await createJob(jobData)

      expect(job.intervalMs).toBe(24 * 60 * 60 * 1000)
      expect(job.interval).toBe('daily')
    })

    it('weekly interval produces correct intervalMs', async () => {
      const jobData = {
        name: 'Weekly Job',
        interval: 'weekly',
        promptTemplate: 'Do weekly thing'
      }

      const job = await createJob(jobData)

      expect(job.intervalMs).toBe(7 * 24 * 60 * 60 * 1000)
      expect(job.interval).toBe('weekly')
    })

    it('every-2-hours interval produces correct intervalMs', async () => {
      const jobData = {
        name: 'Bi-Hourly Job',
        interval: 'every-2-hours',
        promptTemplate: 'Do bi-hourly thing'
      }

      const job = await createJob(jobData)

      expect(job.intervalMs).toBe(2 * 60 * 60 * 1000)
      expect(job.interval).toBe('every-2-hours')
    })
  })

  describe('INTERVAL_OPTIONS', () => {
    it('has expected options', () => {
      expect(INTERVAL_OPTIONS).toContainEqual({
        value: 'hourly',
        label: 'Every Hour',
        ms: 60 * 60 * 1000
      })

      expect(INTERVAL_OPTIONS).toContainEqual({
        value: 'daily',
        label: 'Daily',
        ms: 24 * 60 * 60 * 1000
      })

      expect(INTERVAL_OPTIONS).toContainEqual({
        value: 'weekly',
        label: 'Weekly',
        ms: 7 * 24 * 60 * 60 * 1000
      })

      expect(INTERVAL_OPTIONS.length).toBeGreaterThan(3)
    })
  })

  describe('mergeWithDefaults (tested indirectly via loadJobs)', () => {
    it('missing default jobs get added', async () => {
      readJSONFile.mockResolvedValueOnce({
        version: 1,
        lastUpdated: '2025-01-01T00:00:00.000Z',
        jobs: [
          {
            id: 'job-custom-only',
            name: 'Custom Job',
            description: 'Only custom job',
            category: 'custom',
            interval: 'daily',
            intervalMs: 86400000,
            enabled: false,
            priority: 'MEDIUM',
            autonomyLevel: 'manager',
            promptTemplate: 'Custom work',
            lastRun: null,
            runCount: 0,
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z'
          }
        ]
      })

      const jobs = await getAllJobs()

      expect(jobs.length).toBeGreaterThan(1)
      expect(jobs.find(j => j.id === 'job-custom-only')).toBeDefined()
      expect(jobs.find(j => j.id === 'job-github-repo-maintenance')).toBeDefined()
      expect(jobs.find(j => j.id === 'job-brain-review')).toBeDefined()
    })

    it('user-edited fields on a built-in job are NOT overwritten on restart', async () => {
      readJSONFile.mockResolvedValue({
        version: 1,
        lastUpdated: '2025-01-01T00:00:00.000Z',
        jobs: [
          {
            id: 'job-datadog-error-monitor',
            name: 'DataDog Error Monitor',
            description: 'Old description',
            category: 'datadog-error-monitor',
            interval: 'weekly',
            intervalMs: 7 * 24 * 60 * 60 * 1000,
            scheduledTime: '09:00',
            enabled: true,
            priority: 'LOW',
            autonomyLevel: 'manager',
            promptTemplate: 'My custom Datadog prompt',
            lastRun: '2025-01-02T00:00:00.000Z',
            runCount: 7,
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z'
          }
        ]
      })

      const jobs = await getAllJobs()
      const datadog = jobs.find(j => j.id === 'job-datadog-error-monitor')

      // User-edited additive fields must be preserved
      expect(datadog.scheduledTime).toBe('09:00')
      expect(datadog.interval).toBe('weekly')
      expect(datadog.priority).toBe('LOW')
      expect(datadog.promptTemplate).toBe('My custom Datadog prompt')
      // Runtime state not touched
      expect(datadog.enabled).toBe(true)
      expect(datadog.lastRun).toBe('2025-01-02T00:00:00.000Z')
      expect(datadog.runCount).toBe(7)
    })

    it('a new field missing on an existing job IS populated from defaults', async () => {
      readJSONFile.mockResolvedValue({
        version: 1,
        lastUpdated: '2025-01-01T00:00:00.000Z',
        jobs: [
          {
            id: 'job-datadog-error-monitor',
            name: 'DataDog Error Monitor',
            // intentionally omit scheduledTime to simulate an older stored record
            category: 'datadog-error-monitor',
            interval: 'daily',
            intervalMs: 86400000,
            enabled: false,
            priority: 'MEDIUM',
            autonomyLevel: 'manager',
            promptTemplate: 'My custom Datadog prompt',
            lastRun: null,
            runCount: 0,
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z'
          }
        ]
      })

      const jobs = await getAllJobs()
      const datadog = jobs.find(j => j.id === 'job-datadog-error-monitor')

      // Missing field should be filled in from the default
      expect(datadog.scheduledTime).toBe('08:00')
      // Existing user-set fields remain untouched
      expect(datadog.promptTemplate).toBe('My custom Datadog prompt')
    })

    it('structural field changes (type/scriptHandler) ARE synced regardless of stored value', async () => {
      readJSONFile.mockResolvedValue({
        version: 1,
        lastUpdated: '2025-01-01T00:00:00.000Z',
        jobs: [
          {
            id: 'job-agent-data-cleanup',
            name: 'Agent Data Cleanup',
            description: 'Cleans up old agent data',
            category: 'maintenance',
            interval: 'daily',
            intervalMs: 86400000,
            enabled: false,
            priority: 'LOW',
            autonomyLevel: 'manager',
            promptTemplate: 'Clean up agent data',
            type: 'script',
            scriptHandler: 'STALE_HANDLER', // stale value — should be overwritten
            lastRun: null,
            runCount: 0,
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z'
          }
        ]
      })

      const jobs = await getAllJobs()
      const cleanup = jobs.find(j => j.id === 'job-agent-data-cleanup')

      // Structural field must be corrected to the shipped value
      expect(cleanup.scriptHandler).toBe('agent-data-cleanup')
      expect(cleanup.type).toBe('script')
    })

    it('shipped default update reaches an untouched built-in job', async () => {
      // Existing job has scheduledTime matching its shipped snapshot → untouched
      readJSONFile.mockResolvedValue({
        version: 1,
        lastUpdated: '2025-01-01T00:00:00.000Z',
        jobs: [
          {
            id: 'job-datadog-error-monitor',
            name: 'DataDog Error Monitor',
            description: 'Monitors errors',
            category: 'datadog-error-monitor',
            interval: 'daily',
            intervalMs: 86400000,
            scheduledTime: '06:00',
            enabled: false,
            priority: 'MEDIUM',
            autonomyLevel: 'manager',
            promptTemplate: 'Default datadog prompt',
            lastRun: null,
            runCount: 0,
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
            // Snapshot says '06:00' was the previously shipped value
            _shippedDefaults: { scheduledTime: '06:00' }
          }
        ]
      })

      const jobs = await getAllJobs()
      const datadog = jobs.find(j => j.id === 'job-datadog-error-monitor')

      // The current DEFAULT_JOBS ships scheduledTime '08:00' for datadog-error-monitor.
      // Since existing matches snapshot ('06:00' === '06:00') and differs from new default,
      // the value should be updated to the new shipped default.
      expect(datadog.scheduledTime).toBe('08:00')
      expect(datadog._shippedDefaults.scheduledTime).toBe('08:00')
    })

    it('user customization is preserved when snapshot differs from stored value', async () => {
      // User changed scheduledTime to '09:00' but snapshot records '06:00' as the shipped value
      readJSONFile.mockResolvedValue({
        version: 1,
        lastUpdated: '2025-01-01T00:00:00.000Z',
        jobs: [
          {
            id: 'job-datadog-error-monitor',
            name: 'DataDog Error Monitor',
            description: 'Monitors errors',
            category: 'datadog-error-monitor',
            interval: 'daily',
            intervalMs: 86400000,
            scheduledTime: '09:00',
            enabled: false,
            priority: 'MEDIUM',
            autonomyLevel: 'manager',
            promptTemplate: 'Default datadog prompt',
            lastRun: null,
            runCount: 0,
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
            // Snapshot says '06:00' — user edited to '09:00'
            _shippedDefaults: { scheduledTime: '06:00' }
          }
        ]
      })

      const jobs = await getAllJobs()
      const datadog = jobs.find(j => j.id === 'job-datadog-error-monitor')

      // User's '09:00' must be preserved; snapshot stays '06:00'
      expect(datadog.scheduledTime).toBe('09:00')
      expect(datadog._shippedDefaults.scheduledTime).toBe('06:00')
    })

    it('pre-snapshot job bootstraps _shippedDefaults but preserves value', async () => {
      // Existing job has scheduledTime but NO _shippedDefaults at all
      readJSONFile.mockResolvedValue({
        version: 1,
        lastUpdated: '2025-01-01T00:00:00.000Z',
        jobs: [
          {
            id: 'job-datadog-error-monitor',
            name: 'DataDog Error Monitor',
            description: 'Monitors errors',
            category: 'datadog-error-monitor',
            interval: 'daily',
            intervalMs: 86400000,
            scheduledTime: '06:00',
            enabled: false,
            priority: 'MEDIUM',
            autonomyLevel: 'manager',
            promptTemplate: 'Default datadog prompt',
            lastRun: null,
            runCount: 0,
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z'
            // No _shippedDefaults — this job predates the mechanism
          }
        ]
      })

      const jobs = await getAllJobs()
      const datadog = jobs.find(j => j.id === 'job-datadog-error-monitor')

      // Value is preserved (conservative — can't tell if user edited or if it's old shipped)
      expect(datadog.scheduledTime).toBe('06:00')
      // Snapshot is bootstrapped to the CURRENT shipped default so next release can compare
      expect(datadog._shippedDefaults).toBeDefined()
      expect(datadog._shippedDefaults.scheduledTime).toBe('08:00')
    })

    it('new additive field on existing job is populated and snapshot set', async () => {
      // Existing job has no priority field (simulates an old record missing a new field)
      readJSONFile.mockResolvedValue({
        version: 1,
        lastUpdated: '2025-01-01T00:00:00.000Z',
        jobs: [
          {
            id: 'job-datadog-error-monitor',
            name: 'DataDog Error Monitor',
            description: 'Monitors errors',
            category: 'datadog-error-monitor',
            interval: 'daily',
            intervalMs: 86400000,
            enabled: false,
            autonomyLevel: 'manager',
            promptTemplate: 'Default datadog prompt',
            lastRun: null,
            runCount: 0,
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
            _shippedDefaults: {}
            // No priority field — should be added from default
          }
        ]
      })

      const jobs = await getAllJobs()
      const datadog = jobs.find(j => j.id === 'job-datadog-error-monitor')

      // Missing field gets populated from default
      expect(datadog.priority).toBe('MEDIUM')
      // Snapshot is set so future changes can be detected
      expect(datadog._shippedDefaults.priority).toBe('MEDIUM')
    })
  })

  describe('initJobs save-gating', () => {
    it('persists when shipped-default update reaches an untouched built-in job', async () => {
      // Job has scheduledTime matching snapshot → untouched, default ships new value → dirty
      readJSONFile.mockResolvedValue({
        version: 1,
        lastUpdated: '2025-01-01T00:00:00.000Z',
        jobs: [
          {
            id: 'job-datadog-error-monitor',
            name: 'DataDog Error Monitor',
            description: 'Monitors errors',
            category: 'datadog-error-monitor',
            interval: 'daily',
            intervalMs: 86400000,
            scheduledTime: '06:00',
            enabled: false,
            priority: 'MEDIUM',
            autonomyLevel: 'manager',
            promptTemplate: 'Default datadog prompt',
            lastRun: null,
            runCount: 0,
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
            _shippedDefaults: { scheduledTime: '06:00' }
          }
        ]
      })

      atomicWrite.mockClear()
      const data = await initJobs()

      // The in-memory value is updated to the new shipped default
      const datadog = data.jobs.find(j => j.id === 'job-datadog-error-monitor')
      expect(datadog.scheduledTime).toBe('08:00')
      expect(datadog._shippedDefaults.scheduledTime).toBe('08:00')

      // The updated data was persisted to disk
      expect(atomicWrite).toHaveBeenCalled()
      const [, savedData] = atomicWrite.mock.calls[0]
      const savedDatadog = savedData.jobs.find(j => j.id === 'job-datadog-error-monitor')
      expect(savedDatadog.scheduledTime).toBe('08:00')
      expect(savedDatadog._shippedDefaults.scheduledTime).toBe('08:00')
    })

    it('does not persist when no changes are needed', async () => {
      // Construct a payload that exactly matches all shipped defaults so mergeWithDefaults is a no-op.
      // Use an unrecognized ID so it gets added as a new job — but then use a second call
      // to simulate a restart where nothing changed.
      // Simplest approach: provide a data set where all existing jobs already match defaults exactly.
      readJSONFile.mockResolvedValue({
        version: 1,
        lastUpdated: '2025-01-01T00:00:00.000Z',
        jobs: [] // no existing jobs; only new ones will be added (dirty = true on first call)
      })

      // First call seeds defaults → dirty, saves
      atomicWrite.mockClear()
      await initJobs()
      const firstSaveCount = atomicWrite.mock.calls.length
      expect(firstSaveCount).toBeGreaterThan(0)

      // Second call with the same data that was just "saved" — nothing changed
      // Simulate the re-read returning the exact same merged data (all snapshots bootstrapped)
      const savedData = atomicWrite.mock.calls[0][1]
      readJSONFile.mockResolvedValue(JSON.parse(JSON.stringify(savedData)))

      atomicWrite.mockClear()
      await initJobs()

      // No further saves needed — data is already up to date
      expect(atomicWrite).not.toHaveBeenCalled()
    })

    it('persists when user-edited field leaves snapshot intact on a different field', async () => {
      // User changed scheduledTime (preserves '09:00'), but priority is missing entirely → dirty
      readJSONFile.mockResolvedValue({
        version: 1,
        lastUpdated: '2025-01-01T00:00:00.000Z',
        jobs: [
          {
            id: 'job-datadog-error-monitor',
            name: 'DataDog Error Monitor',
            description: 'Monitors errors',
            category: 'datadog-error-monitor',
            interval: 'daily',
            intervalMs: 86400000,
            scheduledTime: '09:00',
            enabled: false,
            autonomyLevel: 'manager',
            promptTemplate: 'Default datadog prompt',
            lastRun: null,
            runCount: 0,
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
            _shippedDefaults: { scheduledTime: '06:00' }
            // No priority — brand-new field → dirty
          }
        ]
      })

      atomicWrite.mockClear()
      const data = await initJobs()

      // User's scheduledTime must still be '09:00'
      const datadog = data.jobs.find(j => j.id === 'job-datadog-error-monitor')
      expect(datadog.scheduledTime).toBe('09:00')
      // New priority field is populated
      expect(datadog.priority).toBe('MEDIUM')
      // Data was persisted because a new field was added
      expect(atomicWrite).toHaveBeenCalled()
    })
  })

  describe('getAllJobs', () => {
    it('returns all jobs from storage', async () => {
      const jobs = await getAllJobs()

      expect(jobs.length).toBeGreaterThan(0)
      expect(jobs.find(j => j.id === 'job-test-1')).toBeDefined()
    })
  })

  describe('getJob', () => {
    it('returns job by ID', async () => {
      const job = await getJob('job-test-1')

      expect(job).toBeDefined()
      expect(job.id).toBe('job-test-1')
    })

    it('returns null for non-existent job', async () => {
      const job = await getJob('nonexistent')

      expect(job).toBeNull()
    })
  })

  describe('createJob', () => {
    it('creates job with defaults', async () => {
      const newJob = {
        name: 'New Job',
        promptTemplate: 'Do new thing'
      }

      const job = await createJob(newJob)

      expect(job.name).toBe('New Job')
      expect(job.priority).toBe('MEDIUM')
      expect(job.autonomyLevel).toBe('manager')
      expect(job.enabled).toBe(false)
      expect(job.interval).toBe('weekly')
      expect(cosEvents.emit).toHaveBeenCalledWith('jobs:created', {
        id: expect.any(String),
        name: 'New Job'
      })
    })
  })

  describe('updateJob', () => {
    it('updates existing job', async () => {
      const updates = {
        name: 'Updated Name',
        enabled: true
      }

      const job = await updateJob('job-test-1', updates)

      expect(job.name).toBe('Updated Name')
      expect(job.enabled).toBe(true)
      expect(cosEvents.emit).toHaveBeenCalledWith('jobs:updated', {
        id: 'job-test-1',
        updates
      })
    })

    it('returns null for non-existent job', async () => {
      const job = await updateJob('nonexistent', { name: 'Updated' })

      expect(job).toBeNull()
    })
  })

  describe('deleteJob', () => {
    it('deletes existing job', async () => {
      const result = await deleteJob('job-test-1')

      expect(result).toBe(true)
      expect(cosEvents.emit).toHaveBeenCalledWith('jobs:deleted', {
        id: 'job-test-1'
      })
    })

    it('returns false for non-existent job', async () => {
      const result = await deleteJob('nonexistent')

      expect(result).toBe(false)
    })
  })

  describe('recordJobExecution', () => {
    it('updates lastRun and increments runCount', async () => {
      const job = await recordJobExecution('job-test-1')

      expect(job.lastRun).toBeDefined()
      expect(job.runCount).toBe(1)
      expect(cosEvents.emit).toHaveBeenCalledWith('jobs:executed', {
        id: 'job-test-1',
        runCount: 1
      })
    })

    it('returns null for non-existent job', async () => {
      const job = await recordJobExecution('nonexistent')

      expect(job).toBeNull()
    })
  })

  describe('toggleJob', () => {
    it('toggles enabled state from true to false', async () => {
      const job = await toggleJob('job-test-1')

      expect(job.enabled).toBe(false)
      expect(cosEvents.emit).toHaveBeenCalledWith('jobs:toggled', {
        id: 'job-test-1',
        enabled: false
      })
    })

    it('toggles enabled state from false to true', async () => {
      readJSONFile.mockResolvedValue({
        ...mockJobsData,
        jobs: [{
          ...mockJobsData.jobs[0],
          enabled: false
        }]
      })

      const job = await toggleJob('job-test-1')

      expect(job.enabled).toBe(true)
    })

    it('returns null for non-existent job', async () => {
      const job = await toggleJob('nonexistent')

      expect(job).toBeNull()
    })
  })

  describe('getJobStats', () => {
    it('returns correct statistics', async () => {
      readJSONFile.mockResolvedValueOnce({
        version: 1,
        lastUpdated: '2025-01-01T00:00:00.000Z',
        jobs: [
          {
            id: 'job-1',
            name: 'Job 1',
            description: '',
            category: 'test',
            interval: 'daily',
            intervalMs: 86400000,
            enabled: true,
            priority: 'MEDIUM',
            autonomyLevel: 'manager',
            promptTemplate: '',
            lastRun: null,
            runCount: 5,
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z'
          },
          {
            id: 'job-2',
            name: 'Job 2',
            description: '',
            category: 'brain-processing',
            interval: 'daily',
            intervalMs: 86400000,
            enabled: false,
            priority: 'MEDIUM',
            autonomyLevel: 'manager',
            promptTemplate: '',
            lastRun: null,
            runCount: 3,
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z'
          }
        ]
      })

      const stats = await getJobStats()

      expect(stats.total).toBeGreaterThan(0)
      expect(stats.enabled).toBeGreaterThanOrEqual(1)
      expect(stats.disabled).toBeGreaterThanOrEqual(1)
      expect(stats.byCategory.test).toBe(1)
      expect(stats.totalRuns).toBeGreaterThanOrEqual(8)
    })
  })

  describe('script jobs', () => {
    it('isScriptJob returns true for script-type jobs', () => {
      const scriptJob = {
        id: 'job-test',
        type: 'script',
        scriptHandler: 'autobiography-prompt'
      }
      expect(isScriptJob(scriptJob)).toBe(true)
    })

    it('isScriptJob returns false for regular jobs', () => {
      const regularJob = {
        id: 'job-test',
        name: 'Regular Job',
        promptTemplate: 'Do something'
      }
      expect(isScriptJob(regularJob)).toBe(false)
    })

    it('isScriptJob returns false if handler not registered', () => {
      const invalidJob = {
        id: 'job-test',
        type: 'script',
        scriptHandler: 'nonexistent-handler'
      }
      expect(isScriptJob(invalidJob)).toBe(false)
    })

    it('executeScriptJob calls the handler and records execution', async () => {
      readJSONFile.mockResolvedValueOnce({
        version: 1,
        lastUpdated: '2025-01-01T00:00:00.000Z',
        jobs: [
          {
            id: 'job-autobiography-prompt',
            name: 'Autobiography Story Prompt',
            type: 'script',
            scriptHandler: 'autobiography-prompt',
            enabled: true,
            intervalMs: 86400000,
            lastRun: null,
            runCount: 0
          }
        ]
      })

      const scriptJob = {
        id: 'job-autobiography-prompt',
        name: 'Autobiography Story Prompt',
        type: 'script',
        scriptHandler: 'autobiography-prompt'
      }

      const result = await executeScriptJob(scriptJob)

      expect(checkAndPrompt).toHaveBeenCalled()
      expect(result).toEqual({ prompted: true, prompt: { id: 'test-1', text: 'test' } })
      expect(cosEvents.emit).toHaveBeenCalledWith('jobs:script-executed', {
        id: 'job-autobiography-prompt',
        result: { prompted: true, prompt: { id: 'test-1', text: 'test' } }
      })
    })

    it('executeScriptJob throws for non-script jobs', async () => {
      const regularJob = {
        id: 'job-test',
        name: 'Regular Job',
        promptTemplate: 'Do something'
      }

      await expect(executeScriptJob(regularJob)).rejects.toThrow('not a script job')
    })
  })

  describe('agentDataCleanup — paused agent protection', () => {
    beforeEach(() => {
      vi.clearAllMocks()
      reapMergedWorktrees.mockResolvedValue({ reaped: [] })
      cleanupOrphanedWorktrees.mockResolvedValue(0)
      // No active in-memory agents by default
      getActiveAgentIds.mockReturnValue([])
    })

    it('paused agent id is in the activeAgentIds set passed to reapMergedWorktrees', async () => {
      // agentDataCleanup calls readJSONFile once — for data/cos/state.json
      readJSONFile.mockResolvedValueOnce({
        agents: {
          'paused-agent-1': { status: 'paused' },
          'running-agent-2': { status: 'running' }
        }
      })

      await agentDataCleanup()

      expect(reapMergedWorktrees).toHaveBeenCalledOnce()
      const [, opts] = reapMergedWorktrees.mock.calls[0]
      expect(opts.activeAgentIds.has('paused-agent-1')).toBe(true)
    })

    it('paused agent id is in the set passed to cleanupOrphanedWorktrees', async () => {
      readJSONFile.mockResolvedValueOnce({
        agents: {
          'paused-agent-1': { status: 'paused' },
          'running-agent-2': { status: 'running' }
        }
      })

      await agentDataCleanup()

      expect(cleanupOrphanedWorktrees).toHaveBeenCalledOnce()
      const [, activeIds] = cleanupOrphanedWorktrees.mock.calls[0]
      expect(activeIds.has('paused-agent-1')).toBe(true)
    })

    it('non-paused agent is NOT added to the protect set via state.json', async () => {
      readJSONFile.mockResolvedValueOnce({
        agents: {
          'paused-agent-1': { status: 'paused' },
          'running-agent-2': { status: 'running' }
        }
      })

      await agentDataCleanup()

      const [, opts] = reapMergedWorktrees.mock.calls[0]
      // running-agent-2 is not paused and not in getActiveAgentIds() → NOT in protect set
      expect(opts.activeAgentIds.has('running-agent-2')).toBe(false)
    })

    it('in-memory active agents are also protected alongside paused agents', async () => {
      getActiveAgentIds.mockReturnValue(['live-agent-99'])
      readJSONFile.mockResolvedValueOnce({
        agents: { 'paused-agent-1': { status: 'paused' } }
      })

      await agentDataCleanup()

      const [, opts] = reapMergedWorktrees.mock.calls[0]
      expect(opts.activeAgentIds.has('paused-agent-1')).toBe(true)
      expect(opts.activeAgentIds.has('live-agent-99')).toBe(true)
    })

    it('handles missing cosState gracefully (null state.json)', async () => {
      readJSONFile.mockResolvedValueOnce(null)

      await expect(agentDataCleanup()).resolves.not.toThrow()
      expect(reapMergedWorktrees).toHaveBeenCalledOnce()
      expect(cleanupOrphanedWorktrees).toHaveBeenCalledOnce()
    })
  })
})
