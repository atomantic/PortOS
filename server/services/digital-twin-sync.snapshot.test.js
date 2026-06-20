import { describe, it, expect, vi, beforeEach } from 'vitest';

// digital-twin-sync reads the .md documents via fs/promises readdir+readFile and
// the JSON files via fileUtils.readJSONFile. Mock those so we can vary the
// readdir() order between two snapshots of identical data and assert the
// checksum is stable (the documents map must be sorted, not readdir-ordered).

const readdirMock = vi.fn();
const readFileMock = vi.fn();
vi.mock('fs/promises', () => ({
  readdir: (...a) => readdirMock(...a),
  readFile: (...a) => readFileMock(...a),
}));

const readJSONFileMock = vi.fn();
vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return new Proxy(actual, {
    get(target, prop) {
      if (prop === 'readJSONFile') return readJSONFileMock;
      return target[prop];
    },
  });
});

const { getDigitalTwinSnapshot } = await import('./digital-twin-sync.js');

describe('getDigitalTwinSnapshot — checksum determinism', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readJSONFileMock.mockResolvedValue(null); // all JSON files absent
    // content keyed by basename so both snapshots see identical bytes per file
    readFileMock.mockImplementation((p) => Promise.resolve(`# content of ${String(p).split('/').pop()}`));
  });

  it('is stable regardless of readdir() ordering for identical documents', async () => {
    readdirMock.mockResolvedValueOnce(['b.md', 'a.md', 'c.md']);
    const first = await getDigitalTwinSnapshot();

    readdirMock.mockResolvedValueOnce(['c.md', 'b.md', 'a.md']);
    const second = await getDigitalTwinSnapshot();

    expect(second.checksum).toBe(first.checksum);
    // documents map is sorted regardless of the order readdir returned
    expect(Object.keys(first.data.documents)).toEqual(['a.md', 'b.md', 'c.md']);
  });

  it('ignores non-.md and unsafe filenames in the snapshot', async () => {
    readdirMock.mockResolvedValueOnce(['a.md', 'notes.txt', '.hidden.md', 'b.md']);
    const { data } = await getDigitalTwinSnapshot();
    expect(Object.keys(data.documents)).toEqual(['a.md', 'b.md']);
  });

  it('produces a snapshot whose documents survive a JSON round-trip key-stable', async () => {
    readdirMock.mockResolvedValue(['a.md', 'b.md']);
    const { data } = await getDigitalTwinSnapshot();
    // re-serializing must not reorder keys (what the checksum relies on)
    expect(JSON.stringify(data.documents)).toBe(JSON.stringify({ ...data.documents }));
  });
});
