import { describe, it, expect } from 'vitest';
import { Readable, Writable } from 'stream';
import {
  redactSecrets,
  buildBundleFiles,
  buildManifest,
  buildLegacyZip,
  buildLegacyPdf,
  previewLegacyExport,
  getSectionKeys,
} from './legacyExport.js';
import { parseZip } from '../lib/zipStream.js';

// Round-trip a zip Buffer through the production parser → { path: Buffer }.
function unzip(zipBuf) {
  return new Promise((resolve, reject) => {
    const entryPromises = [];
    const parser = parseZip();
    parser.on('entry', (entry) => {
      entryPromises.push(new Promise((res) => {
        const chunks = [];
        const sink = new Writable({ write(chunk, _, cb) { chunks.push(chunk); cb(); } });
        sink.on('finish', () => res({ path: entry.path, data: Buffer.concat(chunks) }));
        entry.pipe(sink);
      }));
    });
    parser.on('close', () => Promise.all(entryPromises).then(
      (entries) => resolve(Object.fromEntries(entries.map(e => [e.path, e.data]))),
      reject,
    ));
    parser.on('error', reject);
    Readable.from([zipBuf]).pipe(parser);
  });
}

// A representative gathered-data object — exercises every section.
function sampleData() {
  return {
    twinPrompt: '# Twin\nYou are helping someone.',
    claudeMd: '# Soul\n',
    stories: [{ id: 's1', themeId: 'childhood', prompt: 'Earliest memory?', content: 'A summer.', createdAt: '2020-01-01' }],
    genome: { uploaded: true, snpCount: 600000, markerCount: 42 },
    taste: { sections: [{ label: 'Music', status: 'complete', summary: 'Loves jazz.' }] },
    chronotype: { type: 'Lion', confidence: 0.8 },
    longevity: { estimatedLifeExpectancy: 90 },
    traits: { dimensions: { openness: { score: 80, label: 'High' } }, summary: 'Curious.' },
    brain: {
      people: [{ id: 'p1', name: 'Ada', content: 'A friend.' }],
      projects: [{ id: 'pr1', title: 'PortOS', content: 'Personal OS.', tags: ['code'] }],
      ideas: [], journals: [{ id: 'j1', title: 'Day 1', content: 'Started.' }], links: [],
    },
    memories: [{ id: 'm1', category: 'work', summary: 'Shipped a feature.' }],
    goals: [{ id: 'g1', title: 'Write a book', status: 'active', progress: 30, description: 'A novel.',
      milestones: [{ id: 'ms1', title: 'Outline', completedAt: '2024-05-01T00:00:00Z' }] }],
    health: { resting_heart_rate: { value: 58, date: '2026-06-10' } },
  };
}

describe('redactSecrets', () => {
  it('masks an OpenAI-style key', () => {
    expect(redactSecrets('key sk-abcdefghijklmnopqrstuvwxyz012345')).toContain('[REDACTED]');
  });
  it('masks a GitHub PAT', () => {
    expect(redactSecrets('ghp_0123456789abcdefghijklmnopqrstuvwx')).toBe('[REDACTED]');
  });
  it('masks a quoted password/secret assignment', () => {
    expect(redactSecrets('"password": "hunter2hunter2"')).toContain('[REDACTED]');
    expect(redactSecrets('"password": "hunter2hunter2"')).not.toContain('hunter2');
    expect(redactSecrets("api_key='abcdef123456'")).not.toContain('abcdef123456');
  });
  it('masks a PEM private-key block', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEv...base64...\n-----END PRIVATE KEY-----';
    expect(redactSecrets(pem)).toBe('[REDACTED PRIVATE KEY]');
  });
  it('does NOT mangle free-text prose that mentions secret/password words', () => {
    // Regression for the tightened quoted-value rule — these are autobiography/journal
    // sentences, not config, and must survive verbatim.
    for (const prose of [
      'My biggest secret: I never learned to swim properly.',
      'The secret: always be kind to strangers.',
      'password = freedom, in my philosophy of life.',
    ]) {
      expect(redactSecrets(prose)).toBe(prose);
    }
  });
  it('leaves ordinary prose untouched', () => {
    const prose = 'I grew up near the ocean and loved skateboarding.';
    expect(redactSecrets(prose)).toBe(prose);
  });
  it('passes through non-strings', () => {
    expect(redactSecrets(null)).toBe(null);
    expect(redactSecrets(42)).toBe(42);
  });
});

describe('buildBundleFiles', () => {
  it('includes every present section with no filter', () => {
    const { files, sections } = buildBundleFiles(sampleData());
    const names = files.map(f => f.name);
    expect(names).toContain('identity/digital-twin-prompt.md');
    expect(names).toContain('autobiography/autobiography.md');
    expect(names).toContain('brain/people.md');
    expect(names).toContain('brain/memories.md');
    expect(names).toContain('goals/goals.md');
    expect(names).toContain('decisions/key-decisions.md');
    expect(names).toContain('health/health-summary.md');
    expect(sections.health.present).toBe(true);
    expect(sections.brain.memories).toBe(1);
  });

  it('honors a section filter', () => {
    const { files, sections } = buildBundleFiles(sampleData(), { sections: ['goals'] });
    const names = files.map(f => f.name);
    expect(names).toContain('goals/goals.md');
    expect(names.some(n => n.startsWith('autobiography/'))).toBe(false);
    // present is still reported true even when excluded from this bundle
    expect(sections.autobiography.present).toBe(true);
    expect(sections.autobiography.included).toBe(false);
    expect(sections.goals.included).toBe(true);
  });

  it('stamps each section with its human label so the UI need not duplicate a key→label map', () => {
    const { sections } = buildBundleFiles(sampleData());
    expect(sections.identity.label).toBe('Identity & Values');
    expect(sections.goals.label).toBe('Goals & Milestones');
    // Labels are present even for absent sections (driven off the descriptor, not data).
    const empty = { twinPrompt: '', claudeMd: '', stories: [], genome: { uploaded: false },
      taste: { sections: [] }, chronotype: null, longevity: null, traits: null,
      brain: { people: [], projects: [], ideas: [], journals: [], links: [] },
      memories: [], goals: [], health: {} };
    expect(buildBundleFiles(empty).sections.health.label).toBe('Health Summary');
  });

  it('marks absent sections present:false and emits no files for them', () => {
    const empty = { twinPrompt: '', claudeMd: '', stories: [], genome: { uploaded: false },
      taste: { sections: [] }, chronotype: null, longevity: null, traits: null,
      brain: { people: [], projects: [], ideas: [], journals: [], links: [] },
      memories: [], goals: [], health: {} };
    const { files, sections } = buildBundleFiles(empty);
    expect(sections.autobiography.present).toBe(false);
    expect(sections.health.present).toBe(false);
    expect(files.some(f => f.name.startsWith('autobiography/'))).toBe(false);
  });

  it('redacts secrets pasted into brain content — in BOTH the Markdown and the JSON mirror', () => {
    const d = sampleData();
    d.brain.journals[0].content = 'token ghp_0123456789abcdefghijklmnopqrstuvwx end';
    const { files } = buildBundleFiles(d);
    const journal = files.find(f => f.name === 'brain/journals.md');
    expect(journal.data.toString()).toContain('[REDACTED]');
    expect(journal.data.toString()).not.toContain('ghp_0123');
    // The machine-readable mirror must not leak it either (review finding).
    const brainJson = files.find(f => f.name === 'data/brain.json');
    expect(brainJson.data.toString()).toContain('[REDACTED]');
    expect(brainJson.data.toString()).not.toContain('ghp_0123');
  });

  it('surfaces HRV stored under the canonical sdnn key', () => {
    const d = sampleData();
    d.health.heart_rate_variability_sdnn = { value: 45, date: '2026-06-11' };
    const { files, sections } = buildBundleFiles(d);
    expect(sections.health.metrics).toBeGreaterThanOrEqual(2);
    const health = files.find(f => f.name === 'health/health-summary.md');
    expect(health.data.toString()).toMatch(/Heart rate variability.*45/);
  });

  it('includes a health source caveat', () => {
    const { files } = buildBundleFiles(sampleData());
    const health = files.find(f => f.name === 'health/health-summary.md');
    expect(health.data.toString()).toMatch(/not a verified medical record/i);
    expect(health.data.toString()).toContain('last sync 2026-06-10');
  });
});

describe('buildManifest', () => {
  it('hashes every file with a SHA-256 and stamps kind/schemaVersion', () => {
    const { files, sections } = buildBundleFiles(sampleData());
    const manifest = buildManifest(files, { sections, portosVersion: '1.2.3', generatedAt: '2026-06-18T00:00:00Z' });
    expect(manifest.kind).toBe('portos-legacy-export');
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.fileCount).toBe(files.length);
    for (const name of Object.keys(manifest.files)) {
      expect(manifest.files[name]).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe('buildLegacyZip', () => {
  it('produces a valid zip that unzips to README + manifest + section files', async () => {
    // gatherLegacyData runs against the live (test) backends; each source is
    // catch-guarded, so the bundle is built regardless of what data exists.
    const { buffer, manifest } = await buildLegacyZip({});
    const entries = await unzip(buffer);
    expect(entries['README.md'].toString()).toMatch(/Privacy notice/);
    expect(entries['manifest.json']).toBeDefined();
    const parsed = JSON.parse(entries['manifest.json'].toString());
    expect(parsed.kind).toBe('portos-legacy-export');
    expect(parsed.fileCount).toBe(manifest.fileCount);
    // Every manifest-listed file (except manifest.json itself) is in the zip.
    for (const name of Object.keys(parsed.files)) {
      expect(entries[name]).toBeDefined();
    }
  });

  it('emits legacy-export socket events when io is provided', async () => {
    const events = [];
    const io = { emit: (e, p) => events.push([e, p]) };
    await buildLegacyZip({ io });
    expect(events.map(e => e[0])).toEqual(
      expect.arrayContaining(['legacy-export:started', 'legacy-export:progress', 'legacy-export:completed']),
    );
  });
});

describe('buildManifest pdf flag', () => {
  it('defaults pdf.included false with no pdf file entry', () => {
    const { files, sections } = buildBundleFiles(sampleData());
    const manifest = buildManifest(files, { sections, portosVersion: '1.0.0', generatedAt: '2026-06-18T00:00:00Z' });
    expect(manifest.pdf.included).toBe(false);
    expect(manifest.pdf.file).toBeUndefined();
  });

  it('records pdf.included + file name when pdfIncluded is true', () => {
    const { files, sections } = buildBundleFiles(sampleData());
    const manifest = buildManifest(files, { sections, portosVersion: '1.0.0', generatedAt: '2026-06-18T00:00:00Z', pdfIncluded: true });
    expect(manifest.pdf.included).toBe(true);
    expect(manifest.pdf.file).toBe('legacy-portrait.pdf');
  });
});

describe('buildLegacyPdf', () => {
  it('renders a non-empty multi-page PDF from the section Markdown', async () => {
    const { files } = buildBundleFiles(sampleData());
    const contentFiles = [{ name: 'README.md', data: Buffer.from('# PortOS Legacy Export\n\nPrivacy notice.') }, ...files];
    const { bytes, pageCount } = await buildLegacyPdf(contentFiles, { portosVersion: '1.2.3', generatedAt: '2026-06-18T12:00:00Z' });
    expect(bytes.length).toBeGreaterThan(0);
    // Title page + one page per Markdown file (each starts on a fresh page).
    const mdCount = contentFiles.filter(f => f.name.endsWith('.md')).length;
    expect(pageCount).toBeGreaterThanOrEqual(1 + mdCount);
    // PDF magic header.
    expect(Buffer.from(bytes.slice(0, 5)).toString('latin1')).toBe('%PDF-');
  });

  it('does not throw on non-ASCII glyphs (VO₂, em-dash, smart quotes, ⚠️)', async () => {
    const contentFiles = [{ name: 'identity/profile.md', data: Buffer.from('# Health\n\n- **VO₂ max**: 52 — “great” … ⚠️') }];
    const { bytes } = await buildLegacyPdf(contentFiles, {});
    expect(bytes.length).toBeGreaterThan(0);
  });

  it('does not throw on control bytes WinAnsi cannot encode (NUL, VT, ESC, DEL, C1)', async () => {
    // Stray control chars pasted into free-text identity content (a note, a
    // journal) must not crash the whole PDF render. pdf-lib's WinAnsi encoder
    // throws on 0x00–0x1F / 0x7F / 0x80–0x9F even though they're ≤ 0xFF.
    const dirty = 'before\x00\x0B\x1B\x7F\x9Dafter and a\ttab';
    const contentFiles = [{ name: 'brain/journals.md', data: Buffer.from(`# Journal\n\n${dirty}\n`) }];
    const { bytes, pageCount } = await buildLegacyPdf(contentFiles, {});
    expect(bytes.length).toBeGreaterThan(0);
    expect(pageCount).toBeGreaterThanOrEqual(2);
  });
});

describe('buildLegacyZip includePdf', () => {
  it('adds a non-empty legacy-portrait.pdf and reflects it in the manifest', async () => {
    const { buffer, manifest } = await buildLegacyZip({ includePdf: true });
    expect(manifest.pdf.included).toBe(true);
    expect(manifest.pdf.file).toBe('legacy-portrait.pdf');
    expect(manifest.files['legacy-portrait.pdf']).toMatch(/^[0-9a-f]{64}$/);
    const entries = await unzip(buffer);
    expect(entries['legacy-portrait.pdf']).toBeDefined();
    expect(entries['legacy-portrait.pdf'].length).toBeGreaterThan(0);
    expect(entries['legacy-portrait.pdf'].slice(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('omits the PDF by default and leaves manifest pdf.included false', async () => {
    const { buffer, manifest } = await buildLegacyZip({});
    expect(manifest.pdf.included).toBe(false);
    const entries = await unzip(buffer);
    expect(entries['legacy-portrait.pdf']).toBeUndefined();
  });
});

describe('previewLegacyExport', () => {
  it('returns section metadata and an estimated size without throwing', async () => {
    const preview = await previewLegacyExport();
    expect(preview).toHaveProperty('sections');
    expect(typeof preview.estimatedBytes).toBe('number');
    expect(preview.fileCount).toBeGreaterThanOrEqual(2); // README + manifest at minimum
  });
});

describe('getSectionKeys', () => {
  it('lists the known sections', () => {
    expect(getSectionKeys()).toEqual(['identity', 'autobiography', 'brain', 'goals', 'decisions', 'health']);
  });
});
