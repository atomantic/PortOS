import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../lib/fileUtils.js', () => ({
  ensureDir: vi.fn().mockResolvedValue(),
  readJSONFile: vi.fn(),
  PATHS: { data: '/mock/data' }
}))

vi.mock('fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(),
  rename: vi.fn().mockResolvedValue()
}))

vi.mock('../lib/uuid.js', () => ({
  v4: vi.fn(() => 'test-uuid-1234')
}))

vi.mock('../lib/asyncMutex.js', () => ({
  createMutex: () => (fn) => fn()
}))

import {
  getNotifications,
  getUnreadCount,
  getCountsByType,
  addNotification,
  removeNotification,
  removeByMetadata,
  markAsRead,
  markAllAsRead,
  clearAll,
  exists,
  invalidateCache,
  NOTIFICATION_TYPES,
  PRIORITY_LEVELS,
  notificationEvents
} from './notifications.js'
import { readJSONFile } from '../lib/fileUtils.js'

describe('notifications', () => {
  const baseNotifications = {
    version: 1,
    notifications: [
      {
        id: 'n1',
        type: NOTIFICATION_TYPES.MEMORY_APPROVAL,
        title: 'Memory needs review',
        description: 'Classify this memory',
        priority: PRIORITY_LEVELS.MEDIUM,
        timestamp: '2025-01-02T00:00:00.000Z',
        link: '/brain/memory',
        read: false,
        metadata: { memoryId: 'mem-1' }
      },
      {
        id: 'n2',
        type: NOTIFICATION_TYPES.CODE_REVIEW,
        title: 'Review PR #42',
        description: 'Code review needed',
        priority: PRIORITY_LEVELS.HIGH,
        timestamp: '2025-01-01T00:00:00.000Z',
        link: '/cos/agents',
        read: true,
        metadata: { prNumber: 42 }
      },
      {
        id: 'n3',
        type: NOTIFICATION_TYPES.HEALTH_ISSUE,
        title: 'High heart rate detected',
        description: 'HR exceeded threshold',
        priority: PRIORITY_LEVELS.CRITICAL,
        timestamp: '2025-01-03T00:00:00.000Z',
        link: '/meatspace/health',
        read: false,
        metadata: {}
      }
    ]
  }

  beforeEach(() => {
    vi.clearAllMocks()
    invalidateCache()
    readJSONFile.mockResolvedValue(JSON.parse(JSON.stringify(baseNotifications)))
  })

  describe('NOTIFICATION_TYPES', () => {
    it('should define expected notification types', () => {
      expect(NOTIFICATION_TYPES.MEMORY_APPROVAL).toBe('memory_approval')
      expect(NOTIFICATION_TYPES.TASK_APPROVAL).toBe('task_approval')
      expect(NOTIFICATION_TYPES.CODE_REVIEW).toBe('code_review')
      expect(NOTIFICATION_TYPES.HEALTH_ISSUE).toBe('health_issue')
      expect(NOTIFICATION_TYPES.BRIEFING_READY).toBe('briefing_ready')
      expect(NOTIFICATION_TYPES.AGENT_WARNING).toBe('agent_warning')
    })
  })

  describe('PRIORITY_LEVELS', () => {
    it('should define expected priority levels', () => {
      expect(PRIORITY_LEVELS.LOW).toBe('low')
      expect(PRIORITY_LEVELS.MEDIUM).toBe('medium')
      expect(PRIORITY_LEVELS.HIGH).toBe('high')
      expect(PRIORITY_LEVELS.CRITICAL).toBe('critical')
    })
  })

  describe('getNotifications', () => {
    it('should return all notifications sorted by timestamp descending', async () => {
      const notifications = await getNotifications()
      expect(notifications).toHaveLength(3)
      // Newest first
      expect(notifications[0].id).toBe('n3')
      expect(notifications[1].id).toBe('n1')
      expect(notifications[2].id).toBe('n2')
    })

    it('should filter by type', async () => {
      const notifications = await getNotifications({ type: NOTIFICATION_TYPES.CODE_REVIEW })
      expect(notifications).toHaveLength(1)
      expect(notifications[0].id).toBe('n2')
    })

    it('should filter unread only', async () => {
      const notifications = await getNotifications({ unreadOnly: true })
      expect(notifications).toHaveLength(2)
      notifications.forEach(n => expect(n.read).toBe(false))
    })

    it('should apply limit', async () => {
      const notifications = await getNotifications({ limit: 1 })
      expect(notifications).toHaveLength(1)
      expect(notifications[0].id).toBe('n3')
    })

    it('should combine filters', async () => {
      const notifications = await getNotifications({
        unreadOnly: true,
        limit: 1
      })
      expect(notifications).toHaveLength(1)
      expect(notifications[0].read).toBe(false)
    })
  })

  describe('getUnreadCount', () => {
    it('should count unread notifications', async () => {
      const count = await getUnreadCount()
      expect(count).toBe(2)
    })

    it('should return 0 when all read', async () => {
      readJSONFile.mockResolvedValue({
        version: 1,
        notifications: [
          { id: 'n1', read: true, type: 'test' }
        ]
      })
      invalidateCache()
      const count = await getUnreadCount()
      expect(count).toBe(0)
    })
  })

  describe('getCountsByType', () => {
    it('should return counts grouped by type', async () => {
      const counts = await getCountsByType()
      expect(counts.total).toBe(3)
      expect(counts.unread).toBe(2)
      expect(counts.byType[NOTIFICATION_TYPES.MEMORY_APPROVAL]).toBe(1)
      expect(counts.byType[NOTIFICATION_TYPES.CODE_REVIEW]).toBe(1)
      expect(counts.byType[NOTIFICATION_TYPES.HEALTH_ISSUE]).toBe(1)
    })
  })

  describe('addNotification', () => {
    it('should add a notification with generated fields', async () => {
      const result = await addNotification({
        type: NOTIFICATION_TYPES.TASK_APPROVAL,
        title: 'New task pending',
        description: 'Review this task',
        priority: PRIORITY_LEVELS.LOW,
        link: '/cos/tasks',
        metadata: { taskId: 't1' }
      })

      expect(result.id).toBe('test-uuid-1234')
      expect(result.type).toBe(NOTIFICATION_TYPES.TASK_APPROVAL)
      expect(result.title).toBe('New task pending')
      expect(result.read).toBe(false)
      expect(result.timestamp).toBeDefined()
      expect(result.metadata.taskId).toBe('t1')
    })

    it('should use default priority when not specified', async () => {
      const result = await addNotification({
        type: NOTIFICATION_TYPES.BRIEFING_READY,
        title: 'Briefing ready'
      })

      expect(result.priority).toBe(PRIORITY_LEVELS.MEDIUM)
    })

    it('should handle missing optional fields', async () => {
      const result = await addNotification({
        type: NOTIFICATION_TYPES.BRIEFING_READY,
        title: 'Test'
      })

      expect(result.description).toBe('')
      expect(result.link).toBeNull()
      expect(result.metadata).toEqual({})
    })

    it('should emit events when notification added', async () => {
      const addedSpy = vi.fn()
      const countSpy = vi.fn()
      notificationEvents.on('added', addedSpy)
      notificationEvents.on('count-changed', countSpy)

      await addNotification({
        type: NOTIFICATION_TYPES.TASK_APPROVAL,
        title: 'Test'
      })

      expect(addedSpy).toHaveBeenCalledOnce()
      expect(countSpy).toHaveBeenCalled()

      notificationEvents.off('added', addedSpy)
      notificationEvents.off('count-changed', countSpy)
    })
  })

  describe('removeNotification', () => {
    it('should remove an existing notification', async () => {
      const result = await removeNotification('n1')
      expect(result.success).toBe(true)
      expect(result.notification.id).toBe('n1')
    })

    it('should return error for non-existent notification', async () => {
      const result = await removeNotification('nonexistent')
      expect(result.success).toBe(false)
      expect(result.error).toBe('Notification not found')
    })
  })

  describe('removeByMetadata', () => {
    it('should remove notifications matching metadata field/value', async () => {
      const result = await removeByMetadata('memoryId', 'mem-1')
      expect(result.success).toBe(true)
      expect(result.removed).toBe(1)
    })

    it('should return 0 removed when no matches', async () => {
      const result = await removeByMetadata('memoryId', 'nonexistent')
      expect(result.success).toBe(true)
      expect(result.removed).toBe(0)
    })
  })

  describe('markAsRead', () => {
    it('should mark an unread notification as read', async () => {
      const result = await markAsRead('n1')
      expect(result.success).toBe(true)
      expect(result.notification.read).toBe(true)
    })

    it('should handle already-read notification', async () => {
      const result = await markAsRead('n2')
      expect(result.success).toBe(true)
      expect(result.notification.read).toBe(true)
    })

    it('should return error for non-existent notification', async () => {
      const result = await markAsRead('nonexistent')
      expect(result.success).toBe(false)
      expect(result.error).toBe('Notification not found')
    })
  })

  describe('markAllAsRead', () => {
    it('should mark all notifications as read', async () => {
      const result = await markAllAsRead()
      expect(result.success).toBe(true)
      expect(result.updated).toBe(2)
    })

    it('should return 0 updated when all already read', async () => {
      readJSONFile.mockResolvedValue({
        version: 1,
        notifications: [
          { id: 'n1', read: true, type: 'test' },
          { id: 'n2', read: true, type: 'test' }
        ]
      })
      invalidateCache()

      const result = await markAllAsRead()
      expect(result.success).toBe(true)
      expect(result.updated).toBe(0)
    })
  })

  describe('clearAll', () => {
    it('should remove all notifications', async () => {
      const result = await clearAll()
      expect(result.success).toBe(true)
      expect(result.cleared).toBe(3)
    })

    it('should emit cleared and count-changed events', async () => {
      const clearedSpy = vi.fn()
      const countSpy = vi.fn()
      notificationEvents.on('cleared', clearedSpy)
      notificationEvents.on('count-changed', countSpy)

      await clearAll()

      expect(clearedSpy).toHaveBeenCalledOnce()
      expect(countSpy).toHaveBeenCalledWith(0)

      notificationEvents.off('cleared', clearedSpy)
      notificationEvents.off('count-changed', countSpy)
    })
  })

  describe('exists', () => {
    it('should return true when notification of type exists', async () => {
      const result = await exists(NOTIFICATION_TYPES.MEMORY_APPROVAL)
      expect(result).toBe(true)
    })

    it('should return false when notification of type does not exist', async () => {
      const result = await exists(NOTIFICATION_TYPES.PLAN_QUESTION)
      expect(result).toBe(false)
    })

    it('should check metadata field/value when provided', async () => {
      const result = await exists(NOTIFICATION_TYPES.MEMORY_APPROVAL, 'memoryId', 'mem-1')
      expect(result).toBe(true)
    })

    it('should return false when metadata does not match', async () => {
      const result = await exists(NOTIFICATION_TYPES.MEMORY_APPROVAL, 'memoryId', 'mem-999')
      expect(result).toBe(false)
    })
  })

  describe('invalidateCache', () => {
    it('should force reload on next access', async () => {
      await getNotifications()
      expect(readJSONFile).toHaveBeenCalledTimes(1)

      invalidateCache()
      await getNotifications()
      expect(readJSONFile).toHaveBeenCalledTimes(2)
    })
  })
})
