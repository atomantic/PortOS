# Testing Patterns

**Analysis Date:** 2026-02-26

## Test Framework

**Runner:**
- Vitest v4.0.16
- Config: `server/vitest.config.js`
- ES modules support (native)

**Assertion Library:**
- Vitest built-in: `expect()` from vitest

**Run Commands:**
```bash
cd server && npm test              # Run all tests (vitest run)
cd server && npm run test:watch    # Watch mode (vitest)
cd server && npm run test:coverage # Coverage report (vitest run --coverage)
```

## Test File Organization

**Location:**
- Co-located with source code in same directory
- Not in separate `__tests__` directory

**Naming:**
- `.test.js` suffix: `validation.test.js`, `errorHandler.test.js`, `logger.test.js`
- Integration tests: `.integration.test.js` suffix (e.g., `visionTest.integration.test.js`)

**Structure:**
```
server/
├── lib/
│   ├── validation.js
│   └── validation.test.js        # Co-located test
├── routes/
│   ├── apps.js
│   └── apps.test.js              # Co-located test
└── services/
    ├── apps.js
    └── apps.test.js              # Co-located test
```

## Test Structure

**Suite Organization:**
```javascript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('Module Name', () => {
  describe('FeatureName', () => {
    it('should do something specific', () => {
      // Test implementation
    });

    it('should handle edge case', () => {
      // Test implementation
    });
  });

  describe('AnotherFeature', () => {
    // More tests
  });
});
```

**Test Patterns:**
- `describe()` blocks group related tests (domain or function-level)
- Nested `describe()` blocks for feature-specific tests
- `it()` for individual test cases with clear, descriptive names starting with "should"
- Tests are independent and can run in any order

Example from `server/lib/validation.test.js`:
```javascript
describe('validation.js', () => {
  describe('processSchema', () => {
    it('should validate a complete process object', () => {
      const process = {
        name: 'test-process',
        port: 3000,
        description: 'A test process'
      };
      const result = processSchema.safeParse(process);
      expect(result.success).toBe(true);
      expect(result.data).toEqual(process);
    });

    it('should reject empty name', () => {
      const process = { name: '' };
      const result = processSchema.safeParse(process);
      expect(result.success).toBe(false);
    });
  });
});
```

## Test Setup/Teardown

**Patterns:**
```javascript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('Module', () => {
  let mockData;

  beforeEach(() => {
    // Fresh setup for each test
    mockData = { id: '123', value: 'test' };
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Cleanup after each test
    vi.clearAllMocks();
    mockData = null;
  });

  it('should test something', () => {
    // Test body
  });
});
```

Example from `server/routes/apps.test.js`:
```javascript
describe('Apps Routes', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/apps', appsRoutes);

    // Reset all mocks
    vi.clearAllMocks();
  });

  it('should return list of apps with PM2 status', async () => {
    // Test implementation
  });
});
```

Example from `server/lib/logger.test.js`:
```javascript
describe('logger', () => {
  let consoleLogSpy;
  let consoleErrorSpy;
  let consoleWarnSpy;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  test('startup logs with rocket emoji', () => {
    logger.startup('Server started');
    expect(consoleLogSpy).toHaveBeenCalledWith('🚀 Server started');
  });
});
```

## Mocking

**Framework:** Vitest built-in `vi` from 'vitest'

**Patterns:**

### Module Mocking:
```javascript
vi.mock('../services/apps.js', () => ({
  getAllApps: vi.fn(),
  getAppById: vi.fn(),
  createApp: vi.fn(),
  updateApp: vi.fn(),
  deleteApp: vi.fn(),
  PORTOS_APP_ID: 'portos-default'
}));

// Then import the mocked module
import * as appsService from '../services/apps.js';

// Usage in tests
appsService.getAllApps.mockResolvedValue(mockApps);
```

### Function Mocking with vi.fn():
```javascript
const mockSocket = {
  id: 'socket-123',
  emit: vi.fn(),
  on: vi.fn()
};

// Assertions on calls
expect(mockSocket.emit).toHaveBeenCalledWith('cos:subscribed');
```

### Spy Mocking:
```javascript
const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
expect(consoleLogSpy).toHaveBeenCalledWith('🚀 Server started');
consoleLogSpy.mockRestore();
```

### Return Value Mocking:
```javascript
appsService.getAllApps.mockResolvedValue([
  { id: 'app-001', name: 'Test App', pm2ProcessNames: ['test-app'] }
]);

pm2Service.listProcesses.mockResolvedValue([
  { name: 'test-app', status: 'online' }
]);
```

Example from `server/routes/apps.test.js`:
```javascript
vi.mock('../services/apps.js', () => ({
  getAllApps: vi.fn(),
  getAppById: vi.fn(),
  createApp: vi.fn(),
  updateApp: vi.fn(),
  deleteApp: vi.fn(),
  archiveApp: vi.fn(),
  notifyAppsChanged: vi.fn(),
  PORTOS_APP_ID: 'portos-default'
}));

vi.mock('../services/pm2.js', () => ({
  listProcesses: vi.fn(),
  getAppStatus: vi.fn(),
  startWithCommand: vi.fn(),
  stopApp: vi.fn(),
  restartApp: vi.fn(),
  getLogs: vi.fn()
}));

// Later in test
appsService.getAllApps.mockResolvedValue(mockApps);
pm2Service.listProcesses.mockResolvedValue(mockPm2Processes);
```

**What to Mock:**
- External service dependencies (apps service, pm2 service, history service)
- HTTP/Socket.IO calls
- File system operations (when testing business logic, not I/O)
- Console methods when testing log output
- EventEmitter instances

**What NOT to Mock:**
- Validation schemas (test real Zod validation)
- Error handler logic (test with real ServerError)
- Core utility functions (test real implementations)
- Internal module logic you're testing

## Fixtures and Factories

**Test Data:**
- Inline mock data in test files (no separate fixtures directory)
- Reusable data objects defined at top of describe blocks or in beforeEach

Example pattern from `server/routes/apps.test.js`:
```javascript
const mockApps = [
  { id: 'app-001', name: 'Test App', pm2ProcessNames: ['test-app'], repoPath: '/tmp/test' }
];

const mockPm2Processes = [
  { name: 'test-app', status: 'online' }
];

// Reuse in multiple tests
appsService.getAllApps.mockResolvedValue(mockApps);
```

Example from `server/lib/errorHandler.test.js`:
```javascript
const testCases = [
  { status: 400, code: 'BAD_REQUEST' },
  { status: 401, code: 'UNAUTHORIZED' },
  { status: 403, code: 'FORBIDDEN' },
  { status: 404, code: 'NOT_FOUND' },
  // ... more cases
];

for (const tc of testCases) {
  const error = new Error('Test');
  error.status = tc.status;
  const normalized = normalizeError(error);
  expect(normalized.code).toBe(tc.code);
}
```

**Location:**
- Test data lives inline in test files
- No separate fixtures directory
- Shared data reused via variables/functions in beforeEach

## Coverage

**Requirements:** 30% threshold for lines, functions, branches, and statements

**Configuration** (in `server/vitest.config.js`):
```javascript
coverage: {
  provider: 'v8',
  reporter: ['text', 'text-summary', 'html'],
  reportsDirectory: './coverage',
  include: ['lib/**/*.js', 'routes/**/*.js', 'services/**/*.js'],
  exclude: [
    '**/*.test.js',
    '**/index.js',
    '**/cos-runner/**'
  ],
  thresholds: {
    lines: 30,
    functions: 30,
    branches: 30,
    statements: 30
  }
}
```

**View Coverage:**
```bash
npm run test:coverage
# Generates HTML report in ./coverage/index.html
```

**Included:**
- `lib/**/*.js` - All utility/library code
- `routes/**/*.js` - All route handlers
- `services/**/*.js` - All service code

**Excluded:**
- `*.test.js` - Test files themselves
- `index.js` - Entry points
- `cos-runner/**` - External agent runner code

## Test Types

**Unit Tests:**
- Scope: Single function or small module
- Approach: Test business logic in isolation with mocked dependencies
- No external I/O (unless testing I/O specifically)
- Fast execution (< 100ms per test)

Example from `server/lib/validation.test.js`:
```javascript
it('should validate a complete process object', () => {
  const process = {
    name: 'test-process',
    port: 3000,
    description: 'A test process'
  };
  const result = processSchema.safeParse(process);
  expect(result.success).toBe(true);
  expect(result.data).toEqual(process);
});
```

**Integration Tests:**
- Scope: Multiple modules working together, typically route + service
- Approach: Mock external services, test request/response cycle
- Uses `supertest` for HTTP testing with Express
- May use real validation and error handling

Example from `server/routes/apps.test.js`:
```javascript
it('should return list of apps with PM2 status', async () => {
  const mockApps = [
    { id: 'app-001', name: 'Test App', pm2ProcessNames: ['test-app'], repoPath: '/tmp/test' }
  ];
  const mockPm2Processes = [
    { name: 'test-app', status: 'online' }
  ];

  appsService.getAllApps.mockResolvedValue(mockApps);
  pm2Service.listProcesses.mockResolvedValue(mockPm2Processes);

  const response = await request(app).get('/api/apps');

  expect(response.status).toBe(200);
  expect(response.body).toHaveLength(1);
  expect(response.body[0].overallStatus).toBe('online');
});
```

**E2E Tests:**
- Framework: Not currently in use
- Vision testing only (integration test with `.integration.test.js` suffix)

## Common Patterns

**Async Testing:**
```javascript
it('should serialize concurrent operations', async () => {
  const withLock = createMutex();
  const results = [];

  const p1 = withLock(async () => {
    await new Promise(r => setTimeout(r, 20));
    results.push('first');
    return 'first';
  });

  const p2 = withLock(async () => {
    results.push('second');
    return 'second';
  });

  const p3 = withLock(async () => {
    results.push('third');
    return 'third';
  });

  await Promise.all([p1, p2, p3]);

  expect(results).toEqual(['first', 'second', 'third']);
});
```

**Error Testing:**
```javascript
it('should propagate errors from the wrapped function', async () => {
  const withLock = createMutex();

  await expect(
    withLock(async () => {
      throw new Error('test error');
    })
  ).rejects.toThrow('test error');
});
```

**HTTP Route Testing with supertest:**
```javascript
import request from 'supertest';
import express from 'express';
import routes from './routes.js';

const app = express();
app.use(express.json());
app.use('/api', routes);

it('should return 200 with correct data', async () => {
  const response = await request(app)
    .get('/api/health');

  expect(response.status).toBe(200);
  expect(response.body.status).toBe('ok');
  expect(response.body.version).toBeDefined();
});
```

**Zod Schema Validation Testing:**
```javascript
it('should validate with safeParse', () => {
  const data = { name: 'Test', repoPath: '/path' };
  const result = appSchema.safeParse(data);
  expect(result.success).toBe(true);
  expect(result.data.type).toBe('express'); // default value
});

it('should reject invalid data', () => {
  const data = { name: '', repoPath: '' };
  const result = appSchema.safeParse(data);
  expect(result.success).toBe(false);
  expect(result.errors).toBeDefined();
  expect(result.errors.length).toBeGreaterThan(0);
});
```

**Mock Callback Testing:**
```javascript
it('should emit error event to errorEvents', () => {
  const listener = vi.fn();
  errorEvents.on('error', listener);

  const error = new ServerError('Test error');
  emitErrorEvent(mockIo, error);

  expect(listener).toHaveBeenCalledWith(error);
  errorEvents.off('error', listener);
});
```

## Test File Examples

**Unit Test:** `server/lib/errorHandler.test.js`
- Tests ServerError class creation with options
- Tests normalizeError() conversion logic
- Tests error code mapping from HTTP status
- Tests emitErrorEvent() with mocked io and event listeners

**Integration Test:** `server/routes/apps.test.js`
- Mocks all services (apps, pm2, history, streamingDetect)
- Tests HTTP GET/POST/PUT/DELETE endpoints
- Uses supertest for request/response testing
- Verifies request validation and response shape
- Tests multiple scenarios: success, empty results, error handling

**Utility Test:** `server/lib/validation.test.js`
- Tests multiple schemas: processSchema, appSchema, providerSchema, runSchema
- Tests valid data with all fields and defaults
- Tests invalid data rejection (empty strings, out-of-range values)
- Tests optional fields (null, omitted)
- Tests validate() wrapper function error formatting

---

*Testing analysis: 2026-02-26*
