import { describe, it, expect } from 'vitest'
import { platform, getListeningPorts, isPortInUse, findAvailablePorts } from './platform.js'

describe('platform module', () => {
  describe('platform constant', () => {
    it('should export the current platform', () => {
      expect(typeof platform).toBe('string')
      expect(platform).toBe(process.platform)
    })
  })

  describe('getListeningPorts', () => {
    it('should return an array of numbers', async () => {
      const ports = await getListeningPorts()
      expect(Array.isArray(ports)).toBe(true)
      for (const port of ports) {
        expect(typeof port).toBe('number')
        expect(Number.isInteger(port)).toBe(true)
      }
    })

    it('should return ports in sorted order', async () => {
      const ports = await getListeningPorts()
      for (let i = 1; i < ports.length; i++) {
        expect(ports[i]).toBeGreaterThanOrEqual(ports[i - 1])
      }
    })

    it('should return unique ports', async () => {
      const ports = await getListeningPorts()
      const unique = new Set(ports)
      expect(unique.size).toBe(ports.length)
    })
  })

  describe('isPortInUse', () => {
    it('should return a boolean', async () => {
      const result = await isPortInUse(59999)
      expect(typeof result).toBe('boolean')
    })
  })

  describe('findAvailablePorts', () => {
    it('should return available ports within range', async () => {
      const ports = await findAvailablePorts(49000, 49100, 3)
      expect(Array.isArray(ports)).toBe(true)
      expect(ports.length).toBeLessThanOrEqual(3)
      for (const port of ports) {
        expect(port).toBeGreaterThanOrEqual(49000)
        expect(port).toBeLessThanOrEqual(49100)
      }
    })

    it('should default to finding 1 port', async () => {
      const ports = await findAvailablePorts(49200, 49300)
      expect(ports.length).toBeLessThanOrEqual(1)
    })

    it('should return empty array when range is exhausted', async () => {
      // Range of 0 ports
      const ports = await findAvailablePorts(49400, 49399, 1)
      expect(ports).toEqual([])
    })
  })
})
