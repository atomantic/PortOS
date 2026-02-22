import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock modules before import
vi.mock('./cosEvents.js', () => ({
  cosEvents: { emit: vi.fn() }
}))

vi.mock('../lib/fileUtils.js', () => ({
  readJSONFile: vi.fn(),
  ensureDir: vi.fn().mockResolvedValue(),
  PATHS: { cos: '/mock/data/cos' }
}))

vi.mock('fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue()
}))

// Import after mocks
import {
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
  INTERVAL_OPTIONS
} from './autonomousJobs.js'
import { readJSONFile } from '../lib/fileUtils.js'
import { cosEvents } from './cosEvents.js'

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
      const defaultJobPrefixes = ['job-github-', 'job-brain-', 'job-daily-', 'job-project-', 'job-moltworld-', 'job-jira-', 'job-autobiography-']
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
      expect(jobs.find(j => j.id === 'job-brain-processing')).toBeDefined()
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
})
