import { describe, it, expect, vi, beforeEach } from 'vitest'

const mgr = vi.hoisted(() => ({
  beginOllamaWorkAfterReload: vi.fn(),
  getBaseUrl: vi.fn(() => 'http://localhost:11434'),
  getInFlightOllamaWorkCount: vi.fn(),
  getResidentModelContext: vi.fn(),
  unloadModel: vi.fn()
}))
vi.mock('./ollamaManager.js', () => mgr)

import { beginOllamaRun } from './ollamaRunWindow.js'

const provider = { id: 'ollama', type: 'api', endpoint: 'http://localhost:11434/v1', numCtx: 131072, modelNumCtx: { mlx: 1048576 } }

describe('beginOllamaRun', () => {
  let release
  beforeEach(() => {
    vi.clearAllMocks()
    release = vi.fn()
    mgr.beginOllamaWorkAfterReload.mockResolvedValue(release)
    mgr.getInFlightOllamaWorkCount.mockReturnValue(1)
    mgr.unloadModel.mockResolvedValue({ unloaded: true })
  })

  it('ignores non-Ollama providers', async () => {
    const cloud = { id: 'x', type: 'api', endpoint: 'https://api.example.com/v1' }
    const run = await beginOllamaRun(cloud, 'm')
    expect(run.provider).toBe(cloud)
    expect(mgr.beginOllamaWorkAfterReload).not.toHaveBeenCalled()
  })

  it('unloads an idle resident model serving a smaller window than configured', async () => {
    mgr.getResidentModelContext.mockResolvedValue(131072)
    const run = await beginOllamaRun(provider, 'mlx')
    expect(mgr.unloadModel).toHaveBeenCalledWith('mlx')
    expect(run.provider).toBe(provider)
    expect(mgr.beginOllamaWorkAfterReload).toHaveBeenCalledOnce()
  })

  it('budgets against the resident window when other runs keep the model busy', async () => {
    mgr.getResidentModelContext.mockResolvedValue(131072)
    mgr.getInFlightOllamaWorkCount.mockReturnValue(2)
    const run = await beginOllamaRun(provider, 'mlx')
    expect(mgr.unloadModel).not.toHaveBeenCalled()
    expect(run.provider.numCtx).toBe(131072)
    expect(run.provider.modelNumCtx.mlx).toBe(131072)
    expect(provider.modelNumCtx.mlx).toBe(1048576)
  })

  it('leaves a model alone when it already serves the configured window or is not resident', async () => {
    mgr.getResidentModelContext.mockResolvedValue(1048576)
    expect((await beginOllamaRun(provider, 'mlx')).provider).toBe(provider)
    mgr.getResidentModelContext.mockResolvedValue(null)
    expect((await beginOllamaRun(provider, 'mlx')).provider).toBe(provider)
    expect(mgr.unloadModel).not.toHaveBeenCalled()
  })
})
