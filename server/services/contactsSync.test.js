import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

let tempDataRoot = createTempDataRoot('portos-contacts-test-');

vi.mock('../lib/fileUtils.js', async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    PATHS: makePathsProxy(actual, { dataRoot: () => tempDataRoot }),
    dataPath: (...parts) => join(tempDataRoot, ...parts),
  };
});

const {
  contactDisplayName,
  normalizeContactRecord,
  mergeContacts,
  buildContactIndex,
  resolveHandleAgainstContacts,
  runSync,
  readContactCache,
  readSyncState,
  checkSetup,
  getStatus,
  clearContactCache,
} = await import('./contactsSync.js');

// Fixtures use reserved NANP 555 numbers only — never real contact data.

describe('contactsSync pure helpers', () => {
  describe('contactDisplayName', () => {
    it('prefers first + last over organization', () => {
      expect(contactDisplayName({
        firstName: 'Jane',
        lastName: 'Doe',
        organization: 'Acme',
      })).toBe('Jane Doe');
    });

    it('falls back to organization for company contacts', () => {
      expect(contactDisplayName({ organization: 'Acme Repair Co' })).toBe('Acme Repair Co');
    });

    it('uses nickname when no first/last', () => {
      expect(contactDisplayName({ nickname: 'Skip' })).toBe('Skip');
    });
  });

  describe('normalizeContactRecord', () => {
    it('normalizes phones and emails', () => {
      const c = normalizeContactRecord({
        id: '1',
        uniqueId: 'u1',
        firstName: 'Alex',
        lastName: 'Example',
        phones: ['15551234567', '+1 (555) 123-4567'],
        emails: ['Alex@Example.COM'],
      });
      expect(c.phones).toEqual(['+15551234567']);
      expect(c.emails).toEqual(['alex@example.com']);
      expect(c.displayName).toBe('Alex Example');
    });

    it('returns null when empty', () => {
      expect(normalizeContactRecord({ phones: [], emails: [] })).toBeNull();
    });

    it('omits sourcePath from normalized records', () => {
      const c = normalizeContactRecord({
        id: '1',
        uniqueId: 'u1',
        firstName: 'Alex',
        phones: ['+15551234567'],
        sourcePath: '/tmp/AddressBook/AddressBook-v22.abcddb',
      });
      expect('sourcePath' in c).toBe(false);
    });
  });

  describe('mergeContacts + resolve', () => {
    it('dedupes across sources by phone', () => {
      const merged = mergeContacts([
        [{ uniqueId: 'a', firstName: 'Jane', phones: ['5551234567'], emails: [] }],
        [{ uniqueId: 'b', firstName: 'Jane', lastName: 'Doe', phones: ['+1 555 123 4567'], emails: ['jane@x.com'] }],
      ]);
      expect(merged).toHaveLength(1);
      expect(merged[0].emails).toContain('jane@x.com');
      expect(merged[0].phones).toEqual(['+15551234567']);
    });

    const alice = { uniqueId: 'A', firstName: 'Alice', lastName: 'Example', organization: 'Acme', phones: ['+1 555 010 0001', '+1 555 010 9999'], emails: ['alice@example.com'] };
    const bob = { uniqueId: 'B', firstName: 'Bob', lastName: 'Example', phones: ['+1 555 010 0002', '+1 555 010 9999'], emails: [] };

    it('keeps two different people who share a phone number apart', () => {
      const out = mergeContacts([[alice, bob]]);
      expect(out).toHaveLength(2);
      const index = buildContactIndex(out);
      expect(resolveHandleAgainstContacts('+15550100002', index).displayName).toBe('Bob Example');
      expect(resolveHandleAgainstContacts('+15550100001', index).displayName).toBe('Alice Example');
      expect(resolveHandleAgainstContacts('+15550109999', index).displayName).toBe('Alice Example');
      expect(out.find((c) => c.uniqueId === 'B').phones).not.toContain('+15550100001');
    });

    it('collapses the same uniqueId even when names differ', () => {
      const out = mergeContacts([
        [{ uniqueId: 'X', firstName: 'Alice', phones: ['+15550100001'] }],
        [{ uniqueId: 'X', firstName: 'Bob', phones: ['+15550100002'] }],
      ]);
      expect(out).toHaveLength(1);
      expect(out[0].phones).toHaveLength(2);
    });

    it('merges org-only cards from different sources that share a phone and organization', () => {
      const out = mergeContacts([
        [{ uniqueId: 'O1', organization: 'Acme', phones: ['+15550100005'] }],
        [{ uniqueId: 'O2', organization: 'acme', phones: ['+15550100005'], emails: ['info@example.com'] }],
      ]);
      expect(out).toHaveLength(1);
    });

    it('does not chain distinct people through shared phone then shared email', () => {
      const out = mergeContacts([[
        { uniqueId: 'A', firstName: 'Alice', phones: ['+15550100001'] },
        { uniqueId: 'B', firstName: 'Bob', phones: ['+15550100001'], emails: ['shared@example.com'] },
        { uniqueId: 'C', firstName: 'Carol', emails: ['shared@example.com'] },
      ]]);
      expect(out.map((c) => c.displayName)).toEqual(['Alice', 'Bob', 'Carol']);
    });

    it('resolves handle against contact index', () => {
      const contacts = mergeContacts([[
        { uniqueId: '1', firstName: 'Pat', lastName: 'Lee', phones: ['+1 (555) 987-6543'], emails: [] },
      ]]);
      const index = buildContactIndex(contacts);
      const hit = resolveHandleAgainstContacts('5559876543', index);
      expect(hit.displayName).toBe('Pat Lee');
      expect(hit.source).toBe('contacts');
      expect(resolveHandleAgainstContacts('+19999999999', index)).toBeNull();
    });
  });
});

function createFakeAddressBookDb(dbPath, rows) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE ZABCDRECORD (
        Z_PK INTEGER PRIMARY KEY,
        ZUNIQUEID TEXT,
        ZFIRSTNAME TEXT,
        ZLASTNAME TEXT,
        ZMIDDLENAME TEXT,
        ZNICKNAME TEXT,
        ZORGANIZATION TEXT,
        ZNAME TEXT
      );
      CREATE TABLE ZABCDPHONENUMBER (ZOWNER INTEGER, ZFULLNUMBER TEXT);
      CREATE TABLE ZABCDEMAILADDRESS (ZOWNER INTEGER, ZADDRESS TEXT);
    `);
    const insRec = db.prepare(
      'INSERT INTO ZABCDRECORD (Z_PK, ZUNIQUEID, ZFIRSTNAME, ZLASTNAME, ZMIDDLENAME, ZNICKNAME, ZORGANIZATION, ZNAME) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const insPhone = db.prepare('INSERT INTO ZABCDPHONENUMBER (ZOWNER, ZFULLNUMBER) VALUES (?, ?)');
    const insEmail = db.prepare('INSERT INTO ZABCDEMAILADDRESS (ZOWNER, ZADDRESS) VALUES (?, ?)');
    for (const row of rows) {
      insRec.run(row.pk, row.uniqueId, row.firstName || null, row.lastName || null, null, null, null, null);
      for (const p of row.phones || []) insPhone.run(row.pk, p);
      for (const e of row.emails || []) insEmail.run(row.pk, e);
    }
  } finally {
    db.close();
  }
}

describe('contactsSync cache security and erasure (#18130)', () => {
  let prevAbRoot;
  let abRoot;

  beforeEach(() => {
    prevAbRoot = process.env.CONTACTS_AB_ROOT;
    tempDataRoot = createTempDataRoot('portos-contacts-test-');
    abRoot = createTempDataRoot('portos-contacts-ab-');
    mkdirSync(abRoot, { recursive: true });
    process.env.CONTACTS_AB_ROOT = abRoot;
  });

  afterEach(() => {
    if (prevAbRoot === undefined) delete process.env.CONTACTS_AB_ROOT;
    else process.env.CONTACTS_AB_ROOT = prevAbRoot;
    rmSync(tempDataRoot, { recursive: true, force: true });
    rmSync(abRoot, { recursive: true, force: true });
  });

  it('writes contacts-cache.json with mode 0o600, strips sourcePath, and clears cache + sync state idempotently', async () => {
    const dbPath = join(abRoot, 'AddressBook-v22.abcddb');
    createFakeAddressBookDb(dbPath, [
      { pk: 1, uniqueId: 'u-1', firstName: 'Jane', lastName: 'Doe', phones: ['+1 555 010 1234'], emails: ['jane@example.com'] },
    ]);

    const result = await runSync();
    expect(result.ok).toBe(true);
    expect(result.contactCount).toBe(1);

    const cacheFile = join(tempDataRoot, 'contacts-cache.json');
    const stateFile = join(tempDataRoot, 'contacts-sync-state.json');
    expect(existsSync(cacheFile)).toBe(true);
    expect(existsSync(stateFile)).toBe(true);

    if (process.platform !== 'win32') {
      expect(statSync(cacheFile).mode & 0o777).toBe(0o600);
      expect(statSync(stateFile).mode & 0o777).toBe(0o600);
    }
    expect(readFileSync(stateFile, 'utf8')).not.toContain(homedir());
    expect(JSON.stringify(result)).not.toContain(homedir());
    expect(JSON.stringify(await getStatus())).not.toContain(homedir());

    const cache = await readContactCache();
    expect(cache.contacts).toHaveLength(1);
    expect('sourcePath' in cache.contacts[0]).toBe(false);

    const firstClear = await clearContactCache();
    expect(firstClear).toEqual({ ok: true, cleared: true, cacheRemoved: true, stateRemoved: true });
    expect(existsSync(cacheFile)).toBe(false);
    expect(existsSync(stateFile)).toBe(false);

    const emptyCache = await readContactCache();
    expect(emptyCache.contacts).toEqual([]);
    const emptyState = await readSyncState();
    expect(emptyState.lastRunAt).toBeNull();
    expect(emptyState.lastResult).toBeNull();

    // Idempotent second call when already absent
    const secondClear = await clearContactCache();
    expect(secondClear).toEqual({ ok: true, cleared: true, cacheRemoved: false, stateRemoved: false });
  });

  it('reads each AddressBook SQLite database only once during checkSetup and runSync', async () => {
    const rootDb = join(abRoot, 'AddressBook-v22.abcddb');
    const sourceDir = join(abRoot, 'Sources', 'source-a');
    mkdirSync(sourceDir, { recursive: true });
    const sourceDb = join(sourceDir, 'AddressBook-v22.abcddb');
    createFakeAddressBookDb(rootDb, [
      { pk: 1, uniqueId: 'u-1', firstName: 'Jane', lastName: 'Doe', phones: ['+1 555 010 1234'] },
    ]);
    createFakeAddressBookDb(sourceDb, [
      { pk: 1, uniqueId: 'u-2', firstName: 'John', lastName: 'Smith', emails: ['john@example.com'] },
      { pk: 2, uniqueId: 'u-3', firstName: 'Alex', lastName: 'Ng', emails: ['alex@example.com'] },
    ]);

    const closeSpy = vi.spyOn(DatabaseSync.prototype, 'close');
    try {
      const setup = await checkSetup();
      expect(setup.ok).toBe(true);
      expect(setup.sourceCount).toBe(2);
      expect(setup.rawContactRows).toBe(3);
      expect(closeSpy).toHaveBeenCalledTimes(2);

      closeSpy.mockClear();
      const sync = await runSync();
      expect(sync.ok).toBe(true);
      expect(sync.contactCount).toBe(3);
      expect(sync.sourceCount).toBe(2);
      expect(closeSpy).toHaveBeenCalledTimes(2);
    } finally {
      closeSpy.mockRestore();
    }
  });
});

describe('contactsSync.getStatus (#18279)', () => {
  it('reports cache and state without any setup probe or host paths', async () => {
    const { getStatus } = await import('./contactsSync.js');
    const status = await getStatus();
    expect(Object.keys(status).sort()).toEqual(['cache', 'state']);
  });

  it('scrubs legacy state paths and errors when read and setup paths when returned', async () => {
    const prevAbRoot = process.env.CONTACTS_AB_ROOT;
    const privateRoot = join(homedir(), 'synthetic-contacts-root');
    process.env.CONTACTS_AB_ROOT = privateRoot;
    try {
      const setup = await checkSetup();
      expect(JSON.stringify(setup)).not.toContain(homedir());

      tempDataRoot = createTempDataRoot('portos-contacts-legacy-');
      const legacy = {
        lastRunAt: 'synthetic',
        lastResult: {
          root: join(privateRoot, 'AddressBook'),
          paths: [join(privateRoot, 'AddressBook-v22.abcddb')],
          error: `Could not open ${privateRoot}`,
          remediation: `Check ${privateRoot}`,
          errors: [{ path: join(privateRoot, 'source.db'), error: `Denied at ${privateRoot}` }],
        },
      };
      writeFileSync(join(tempDataRoot, 'contacts-sync-state.json'), JSON.stringify(legacy));
      const state = await readSyncState();
      expect(JSON.stringify(state)).not.toContain(homedir());
      expect(state.lastResult.errors[0].path).toContain('~/');
      expect(state.lastResult.errors[0].error).toContain('~/');
    } finally {
      if (prevAbRoot === undefined) delete process.env.CONTACTS_AB_ROOT;
      else process.env.CONTACTS_AB_ROOT = prevAbRoot;
      rmSync(tempDataRoot, { recursive: true, force: true });
    }
  });
});
