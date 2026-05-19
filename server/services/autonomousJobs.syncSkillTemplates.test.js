import { describe, it, expect, vi, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { writeFile, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

// Create a real tmpdir sandbox hoisted so vi.mock factories can see it
const { ROOT } = vi.hoisted(() => {
  const { mkdtempSync, mkdirSync } = require('fs')
  const { tmpdir } = require('os')
  const { join } = require('path')
  const root = mkdtempSync(join(tmpdir(), 'portos-sync-skill-'))
  mkdirSync(join(root, 'data.sample', 'prompts', 'skills', 'jobs'), { recursive: true })
  mkdirSync(join(root, 'data', 'prompts', 'skills', 'jobs'), { recursive: true })
  return { ROOT: root }
})

// Mock PATHS to point at the tmpdir sandbox; keep real ensureDir so dirs are created
vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js')
  return {
    ...actual,
    PATHS: {
      ...actual.PATHS,
      root: ROOT,
      promptSkillsJobs: `${ROOT}/data/prompts/skills/jobs`,
    },
  }
})

// These mocks satisfy the module's top-level side-effect imports that are
// irrelevant to syncSkillTemplatesFromSample — avoids loading PM2, etc.
vi.mock('./cosEvents.js', () => ({
tryReadFile: vi.fn().mockResolvedValue(null), cosEvents: { emit: vi.fn() } }))
vi.mock('./autobiography.js', () => ({ checkAndPrompt: vi.fn() }))
vi.mock('./goalCheckIn.js', () => ({ runGoalCheckIn: vi.fn() }))
vi.mock('./eventScheduler.js', () => ({ parseCronToNextRun: vi.fn() }))

import { syncSkillTemplatesFromSample } from './autonomousJobs.js'

const SAMPLE_DIR = join(ROOT, 'data.sample', 'prompts', 'skills', 'jobs')
const DEST_DIR = join(ROOT, 'data', 'prompts', 'skills', 'jobs')
const SHIPPED_DIR = join(DEST_DIR, '.shipped')

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

describe('syncSkillTemplatesFromSample', () => {
  it('case a: fresh install seeds file and .shipped', async () => {
    const file = 'test-fresh.md'
    await writeFile(join(SAMPLE_DIR, file), 'v1 content')

    await syncSkillTemplatesFromSample()

    const dest = await readFile(join(DEST_DIR, file), 'utf-8')
    const shipped = await readFile(join(SHIPPED_DIR, file), 'utf-8')
    expect(dest).toBe('v1 content')
    expect(shipped).toBe('v1 content')
  })

  it('case c: unmodified file matching .shipped is replaced when sample changes', async () => {
    const file = 'test-upgrade.md'
    // Simulate a previously-shipped install: dest and .shipped both hold v1
    await writeFile(join(SAMPLE_DIR, file), 'v2 content')
    await writeFile(join(DEST_DIR, file), 'v1 content')
    await writeFile(join(SHIPPED_DIR, file), 'v1 content')

    await syncSkillTemplatesFromSample()

    const dest = await readFile(join(DEST_DIR, file), 'utf-8')
    const shipped = await readFile(join(SHIPPED_DIR, file), 'utf-8')
    expect(dest).toBe('v2 content')
    expect(shipped).toBe('v2 content')
  })

  it('case d: user-modified file is left alone', async () => {
    const file = 'test-custom.md'
    // dest has user customization, .shipped has v1, sample has v2
    await writeFile(join(SAMPLE_DIR, file), 'v2 content')
    await writeFile(join(DEST_DIR, file), 'user custom content')
    await writeFile(join(SHIPPED_DIR, file), 'v1 content')

    await syncSkillTemplatesFromSample()

    const dest = await readFile(join(DEST_DIR, file), 'utf-8')
    const shipped = await readFile(join(SHIPPED_DIR, file), 'utf-8')
    // dest must NOT be overwritten
    expect(dest).toBe('user custom content')
    // .shipped stays at v1 (not updated in case d)
    expect(shipped).toBe('v1 content')
  })

  it('case b: .shipped missing but file matches sample — writes .shipped', async () => {
    const file = 'test-no-shipped.md'
    // File already equals the sample but .shipped doesn't exist yet
    await writeFile(join(SAMPLE_DIR, file), 'v1 content')
    await writeFile(join(DEST_DIR, file), 'v1 content')
    // intentionally no .shipped/<file>

    await syncSkillTemplatesFromSample()

    const shipped = await readFile(join(SHIPPED_DIR, file), 'utf-8')
    const dest = await readFile(join(DEST_DIR, file), 'utf-8')
    expect(shipped).toBe('v1 content')
    // dest must not have been changed
    expect(dest).toBe('v1 content')
  })
})
