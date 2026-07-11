import { describe, it, expect, vi } from 'vitest'
import { platform, parseListeningPorts, getListeningPorts, isPortInUse, findAvailablePorts, isAppleSilicon } from './platform.js'

describe('platform module', () => {
  describe('platform constant', () => {
    it('should export the current platform', () => {
      expect(typeof platform).toBe('string')
      expect(platform).toBe(process.platform)
    })
  })

  describe('getListeningPorts', () => {
    it('parses, deduplicates, and sorts deterministic lsof output', () => {
      const stdout = [
        'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME',
        'node 1 user 20u IPv4 0 0t0 TCP *:6001 (LISTEN)',
        'node 2 user 21u IPv6 0 0t0 TCP [::1]:5555 (LISTEN)',
        'node 3 user 22u IPv4 0 0t0 TCP 127.0.0.1:6001 (LISTEN)',
      ].join('\n')
      expect(parseListeningPorts(stdout, 'darwin')).toEqual([5555, 6001])
    })

    it('parses deterministic ss output', () => {
      const stdout = [
        'State Recv-Q Send-Q Local Address:Port Peer Address:Port Process',
        'LISTEN 0 511 0.0.0.0:7000 0.0.0.0:* users:(("node",pid=1,fd=1))',
        'LISTEN 0 511 [::]:5555 [::]:* users:(("node",pid=2,fd=2))',
      ].join('\n')
      expect(parseListeningPorts(stdout, 'linux')).toEqual([5555, 7000])
    })

    it('parses only LISTENING rows from deterministic netstat output', () => {
      const stdout = [
        '  TCP    0.0.0.0:445     0.0.0.0:0       LISTENING',
        '  TCP    127.0.0.1:6000  127.0.0.1:50000 ESTABLISHED',
        '  TCP    [::]:7000        [::]:0          LISTENING',
      ].join('\n')
      expect(parseListeningPorts(stdout, 'win32')).toEqual([445, 7000])
    })

    it('runs the platform probe and surfaces discovery failure explicitly', async () => {
      const exec = vi.fn()
        .mockResolvedValueOnce({ stdout: 'State Header\nLISTEN 0 511 0.0.0.0:6000 0.0.0.0:*' })
        .mockRejectedValueOnce(new Error('ss: command not found'))

      await expect(getListeningPorts({ platform: 'linux', exec })).resolves.toEqual([6000])
      expect(exec).toHaveBeenCalledWith('ss -lntp', { windowsHide: true })
      await expect(getListeningPorts({ platform: 'linux', exec })).rejects.toMatchObject({
        code: 'PORT_DISCOVERY_FAILED',
        command: 'ss -lntp',
      })
    })
  })

  describe('isPortInUse', () => {
    it('checks a port against deterministic discovery output', async () => {
      const options = {
        platform: 'linux',
        exec: vi.fn().mockResolvedValue({ stdout: 'State Header\nLISTEN 0 511 0.0.0.0:6000 0.0.0.0:*' }),
      }
      await expect(isPortInUse(6000, options)).resolves.toBe(true)
      await expect(isPortInUse(6001, options)).resolves.toBe(false)
    })
  })

  describe('findAvailablePorts', () => {
    it('excludes known occupied ports', async () => {
      const options = {
        platform: 'linux',
        exec: vi.fn().mockResolvedValue({
          stdout: 'State Header\nLISTEN 0 511 0.0.0.0:6000 0.0.0.0:*\nLISTEN 0 511 0.0.0.0:6002 0.0.0.0:*',
        }),
      }
      await expect(findAvailablePorts(6000, 6003, 2, options)).resolves.toEqual([6001, 6003])
    })

    it('should return empty array when range is exhausted', async () => {
      // Range of 0 ports
      const ports = await findAvailablePorts(49400, 49399, 1, {
        platform: 'linux',
        exec: vi.fn().mockResolvedValue({ stdout: '' }),
      })
      expect(ports).toEqual([])
    })

    it('does not advertise ports as free when discovery is unknown', async () => {
      const options = {
        platform: 'linux',
        exec: vi.fn().mockRejectedValue(new Error('permission denied')),
      }
      await expect(findAvailablePorts(6000, 6003, 2, options)).rejects.toMatchObject({
        code: 'PORT_DISCOVERY_FAILED',
      })
    })
  })

  describe('isAppleSilicon', () => {
    it('is false on non-darwin platforms', () => {
      expect(isAppleSilicon({ platform: 'linux', arch: 'x64' })).toBe(false)
      expect(isAppleSilicon({ platform: 'win32', arch: 'arm64' })).toBe(false)
    })

    it('is true on native arm64 darwin without probing hardware', () => {
      let probed = false
      const result = isAppleSilicon({ platform: 'darwin', arch: 'arm64', probe: () => { probed = true; return false } })
      expect(result).toBe(true)
      expect(probed).toBe(false) // native arch short-circuits the sysctl probe
    })

    it('detects Apple Silicon under Rosetta (x64 darwin but arm64 hardware)', () => {
      expect(isAppleSilicon({ platform: 'darwin', arch: 'x64', probe: () => true })).toBe(true)
    })

    it('is false on a genuine Intel Mac (x64 darwin, no arm64 hardware)', () => {
      expect(isAppleSilicon({ platform: 'darwin', arch: 'x64', probe: () => false })).toBe(false)
    })
  })
})
