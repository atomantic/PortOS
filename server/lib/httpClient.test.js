import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHttpClient } from './httpClient.js'
import { mockJsonResponse, mockTextResponse } from './testHelper.js'

// Mock global fetch
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

describe('httpClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const json = (data, status = 200) => mockJsonResponse(data, {
    ok: status >= 200 && status < 300,
    status,
  })
  const text = (body, status = 200) => mockTextResponse(body, {
    ok: status >= 200 && status < 300,
    status,
  })

  describe('createHttpClient', () => {
    it('should return an object with get, post, put, delete methods', () => {
      const client = createHttpClient()
      expect(typeof client.get).toBe('function')
      expect(typeof client.post).toBe('function')
      expect(typeof client.put).toBe('function')
      expect(typeof client.delete).toBe('function')
    })
  })

  describe('GET requests', () => {
    it('should make a GET request with baseURL', async () => {
      mockFetch.mockResolvedValueOnce(json({ ok: true }))
      const client = createHttpClient({ baseURL: 'http://localhost:3000' })

      const result = await client.get('/api/test')

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/test',
        expect.objectContaining({ method: 'GET' })
      )
      expect(result.data).toEqual({ ok: true })
      expect(result.status).toBe(200)
    })

    it('should append query params', async () => {
      mockFetch.mockResolvedValueOnce(json([]))
      const client = createHttpClient({ baseURL: 'http://localhost:3000' })

      await client.get('/items', { params: { page: 1, limit: 10 } })

      const calledUrl = mockFetch.mock.calls[0][0]
      expect(calledUrl).toContain('page=1')
      expect(calledUrl).toContain('limit=10')
    })

    it('should filter out null/undefined params', async () => {
      mockFetch.mockResolvedValueOnce(json([]))
      const client = createHttpClient({ baseURL: 'http://localhost:3000' })

      await client.get('/items', { params: { page: 1, filter: null, sort: undefined } })

      const calledUrl = mockFetch.mock.calls[0][0]
      expect(calledUrl).toContain('page=1')
      expect(calledUrl).not.toContain('filter')
      expect(calledUrl).not.toContain('sort')
    })

    it('should include default headers', async () => {
      mockFetch.mockResolvedValueOnce(json({}))
      const client = createHttpClient({
        baseURL: 'http://localhost:3000',
        headers: { 'Authorization': 'Bearer token123' }
      })

      await client.get('/secure')

      const calledOptions = mockFetch.mock.calls[0][1]
      expect(calledOptions.headers['Authorization']).toBe('Bearer token123')
    })

    it('should merge extra headers with default headers', async () => {
      mockFetch.mockResolvedValueOnce(json({}))
      const client = createHttpClient({
        baseURL: 'http://localhost:3000',
        headers: { 'Authorization': 'Bearer token123' }
      })

      await client.get('/secure', { headers: { 'X-Custom': 'value' } })

      const calledOptions = mockFetch.mock.calls[0][1]
      expect(calledOptions.headers['Authorization']).toBe('Bearer token123')
      expect(calledOptions.headers['X-Custom']).toBe('value')
    })

    it('should handle text responses', async () => {
      mockFetch.mockResolvedValueOnce(text('Hello World'))
      const client = createHttpClient()

      const result = await client.get('/text')
      expect(result.data).toBe('Hello World')
    })
  })

  describe('POST requests', () => {
    it('should send JSON body', async () => {
      mockFetch.mockResolvedValueOnce(json({ id: 1 }, 201))
      const client = createHttpClient({ baseURL: 'http://localhost:3000' })

      const result = await client.post('/items', { name: 'test' })

      const calledOptions = mockFetch.mock.calls[0][1]
      expect(calledOptions.method).toBe('POST')
      expect(calledOptions.body).toBe(JSON.stringify({ name: 'test' }))
      expect(calledOptions.headers['Content-Type']).toBe('application/json')
    })

    it('should not override existing Content-Type header', async () => {
      mockFetch.mockResolvedValueOnce(json({}))
      const client = createHttpClient({
        headers: { 'Content-Type': 'application/xml' }
      })

      await client.post('/items', { name: 'test' })

      const calledOptions = mockFetch.mock.calls[0][1]
      expect(calledOptions.headers['Content-Type']).toBe('application/xml')
    })

    it('should not set Content-Type when no data provided', async () => {
      mockFetch.mockResolvedValueOnce(json({}))
      const client = createHttpClient()

      await client.post('/items')

      const calledOptions = mockFetch.mock.calls[0][1]
      expect(calledOptions.body).toBeUndefined()
    })
  })

  describe('PUT requests', () => {
    it('should make PUT request with body', async () => {
      mockFetch.mockResolvedValueOnce(json({ updated: true }))
      const client = createHttpClient({ baseURL: 'http://localhost:3000' })

      const result = await client.put('/items/1', { name: 'updated' })

      const calledOptions = mockFetch.mock.calls[0][1]
      expect(calledOptions.method).toBe('PUT')
      expect(calledOptions.body).toBe(JSON.stringify({ name: 'updated' }))
      expect(result.data).toEqual({ updated: true })
    })
  })

  describe('DELETE requests', () => {
    it('should make DELETE request', async () => {
      mockFetch.mockResolvedValueOnce(json({ deleted: true }))
      const client = createHttpClient({ baseURL: 'http://localhost:3000' })

      const result = await client.delete('/items/1')

      const calledOptions = mockFetch.mock.calls[0][1]
      expect(calledOptions.method).toBe('DELETE')
      expect(result.data).toEqual({ deleted: true })
    })
  })

  describe('error handling', () => {
    it('should throw on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce(json({ error: 'Not found' }, 404))
      const client = createHttpClient()

      await expect(client.get('/missing')).rejects.toThrow('HTTP 404')
    })

    it('should include status and response data on error', async () => {
      mockFetch.mockResolvedValueOnce(json({ error: 'Forbidden' }, 403))
      const client = createHttpClient()

      try {
        await client.get('/forbidden')
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err.status).toBe(403)
        expect(err.response.data).toEqual({ error: 'Forbidden' })
        expect(err.response.status).toBe(403)
      }
    })

    it('should throw on 500 server error', async () => {
      mockFetch.mockResolvedValueOnce(json({ error: 'Internal error' }, 500))
      const client = createHttpClient()

      await expect(client.get('/error')).rejects.toThrow('HTTP 500')
    })
  })

  describe('no baseURL', () => {
    it('should work without baseURL', async () => {
      mockFetch.mockResolvedValueOnce(json({ ok: true }))
      const client = createHttpClient()

      await client.get('/api/test')

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/test',
        expect.any(Object)
      )
    })
  })
})
