import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getProviderById } from './provider/providers.js';
import { buildPrompt } from './promptService.js';
import { callProviderAI } from './digital-twin-helpers.js';
import { digitalTwinEvents, loadMeta } from './digital-twin-meta.js';
import { createDocument, updateDocument } from './digital-twin-documents.js';
import { calculateConfidence, getAllTwinContent, getGapRecommendations, updateTraits } from './digital-twin-analysis.js';
import { analyzeAssessment, analyzeImportedData } from './digital-twin-import.js';

vi.mock('./provider/providers.js', () => ({ getProviderById: vi.fn() }));
vi.mock('./promptService.js', () => ({ buildPrompt: vi.fn() }));
vi.mock('./digital-twin-helpers.js', async original => ({
  ...await original(),
  callProviderAI: vi.fn()
}));
vi.mock('./digital-twin-meta.js', () => ({
  digitalTwinEvents: { emit: vi.fn() },
  loadMeta: vi.fn()
}));
vi.mock('./digital-twin-documents.js', () => ({ createDocument: vi.fn(), updateDocument: vi.fn() }));
vi.mock('./digital-twin-analysis.js', async original => ({
  ...await original(),
  calculateConfidence: vi.fn(),
  getAllTwinContent: vi.fn(),
  getGapRecommendations: vi.fn(),
  updateTraits: vi.fn()
}));

const providerId = 'synthetic-provider';
const model = 'synthetic-model';

beforeEach(() => {
  vi.clearAllMocks();
  getProviderById.mockResolvedValue({ id: providerId, enabled: true });
  buildPrompt.mockResolvedValue('Synthetic prompt');
  callProviderAI.mockResolvedValue({ text: '{"insights":{"patterns":[]}}' });
});

describe('analyzeImportedData', () => {
  it('keeps multiline Goodreads reviews in one record and excludes unread books', async () => {
    const csv = [
      'Title,Author,My Rating,Date Read,Bookshelves,My Review',
      '"The ""Synthetic"" Book",Example Author,5,,"fiction,short reads","First paragraph, with commas.',
      'Phantom Title,Phantom Author,5,2025/01/01,,Second paragraph."',
      'Unread Book,Example Author,0,,"to-read",',
      'Another Book,Example Writer,0,2025/01/02,fiction,'
    ].join('\r\n');

    const result = await analyzeImportedData('goodreads', csv, providerId, model);

    expect(result).toMatchObject({ source: 'goodreads', itemCount: 2 });
    const { dataDescription } = buildPrompt.mock.calls[0][1];
    expect(dataDescription).toContain('"The "Synthetic" Book" by Example Author (5/5)');
    expect(dataDescription).toContain('Shelves/genres: fiction, short reads');
    expect(dataDescription).toContain('First paragraph, with commas.\r\nPhantom Title,Phantom Author,5,2025/01/01,,Second paragraph.');
    expect(dataDescription).not.toContain('by Phantom Author');
    expect(dataDescription).not.toContain('to-read');
  });

  it.each(['Title,My Rating\nSynthetic Book,5', 'Author,My Rating\nExample Author,5'])(
    'rejects a Goodreads header missing title or author',
    async csv => {
      const result = await analyzeImportedData('goodreads', csv, providerId, model);

      expect(result.error).toContain('No books found');
      expect(callProviderAI).not.toHaveBeenCalled();
    }
  );

  it('keeps multiline Letterboxd reviews together and reads the final film without a newline', async () => {
    const csv = [
      'Name,Year,Rating,Watched Date,Tags,Review',
      '"Film, One",2025,4.5,2025-01-01,"rewatch,short","A ""quoted"" review.',
      'Phantom Film,2024,5,Part two."',
      '',
      'Film Two,2024,4,,fiction,"Short review."'
    ].join('\n');

    const result = await analyzeImportedData('letterboxd', csv, providerId, model);

    expect(result).toMatchObject({ source: 'letterboxd', itemCount: 2 });
    const { dataDescription } = buildPrompt.mock.calls[0][1];
    expect(dataDescription).toContain('Top-rated films: "Film, One" (2025) - 4.5/5, "Film Two" (2024) - 4/5');
    expect(dataDescription).toContain('Tags/themes: rewatch, short, fiction');
    expect(dataDescription).toContain('A "quoted" review.\nPhantom Film,2024,5,Part two.');
  });

  it('aggregates both Spotify field formats by artist and track', async () => {
    const streams = [
      { artistName: 'First Artist', trackName: 'First Track', msPlayed: 1200000 },
      { master_metadata_album_artist_name: 'First Artist', master_metadata_track_name: 'First Track', ms_played: 2400000 },
      { artistName: 'Second Artist', trackName: 'Second Track', msPlayed: 180000 }
    ];

    const result = await analyzeImportedData('spotify', JSON.stringify({ streams }), providerId, model);

    expect(result).toMatchObject({ source: 'spotify', itemCount: 2 });
    const { dataDescription } = buildPrompt.mock.calls[0][1];
    expect(dataDescription).toContain('Listening History (1 hours tracked)');
    expect(dataDescription).toContain('Top artists: First Artist (60 min), Second Artist (3 min)');
    expect(dataDescription).toContain('Top tracks: "First Track" by First Artist, "Second Track" by Second Artist');
  });

  it('summarizes recurring iCal events, including folded summaries and categories', async () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'SUMMARY:Project',
      '  sync',
      'CATEGORIES:Planning,Internal',
      'DTSTART:20250101T120000',
      'RRULE:FREQ=WEEKLY',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'SUMMARY:Lunch with Example Friend',
      'DTSTART:20250101T130000',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    const result = await analyzeImportedData('ical', ics, providerId, model);

    expect(result).toMatchObject({ source: 'ical', itemCount: 2 });
    const { dataDescription } = buildPrompt.mock.calls[0][1];
    expect(dataDescription).toContain('Calendar Analysis (2 events, 1 recurring)');
    expect(dataDescription).toContain('Event types: work: 1, social: 1');
    expect(dataDescription).toContain('Categories: Planning, Internal');
    expect(dataDescription).toContain('Recurring commitments: Project sync');
  });
});

describe('analyzeAssessment', () => {
  it('records invalid suggestions and save failures while applying the rest of the assessment', async () => {
    const traitsUpdated = { bigFive: { openness: 0.7 } };
    const document = filename => ({ filename, content: '# Synthetic assessment' });
    const gaps = [{ dimension: 'extraversion', confidence: 0.2 }];
    const documents = [{ id: 'existing-id', filename: 'existing.md' }];
    loadMeta.mockResolvedValue({ documents, confidence: { overall: 0.2 } });
    getAllTwinContent.mockResolvedValue('');
    callProviderAI.mockResolvedValue({ text: JSON.stringify({
      ...traitsUpdated,
      suggestedDocuments: [
        document('first.md'),
        document('../outside.md'),
        document(42),
        { filename: 'empty.md', content: '' },
        document('failed.md'),
        document('existing.md'),
        document('last.md')
      ]
    }) });
    createDocument.mockImplementation(async data => {
      if (data.filename === 'failed.md') throw new Error('Synthetic write error');
      return data;
    });
    updateDocument.mockResolvedValue(document('existing.md'));
    calculateConfidence.mockResolvedValue({ confidence: { overall: 0.6 } });
    getGapRecommendations.mockResolvedValue(gaps);

    const { analysisResult, gaps: returnedGaps } = await analyzeAssessment('Synthetic assessment', providerId, model);

    expect(updateTraits).toHaveBeenCalledWith(traitsUpdated);
    expect(createDocument.mock.calls.map(([data]) => data.filename)).toEqual(['first.md', 'failed.md', 'last.md']);
    expect(updateDocument).toHaveBeenCalledWith('existing-id', { title: 'existing', content: '# Synthetic assessment' });
    expect(analysisResult).toMatchObject({
      traitsUpdated,
      documentsCreated: ['first.md', 'last.md'],
      documentsUpdated: ['existing.md'],
      documentsSkipped: [
        { filename: '../outside.md', reason: 'invalid_filename' },
        { filename: null, reason: 'invalid_filename' },
        { filename: 'empty.md', reason: 'invalid_content' },
        { filename: 'failed.md', reason: 'save_failed' }
      ],
      confidenceDelta: { before: 0.2, after: 0.6 }
    });
    expect(calculateConfidence).toHaveBeenCalledTimes(1);
    expect(getGapRecommendations).toHaveBeenCalledAfter(calculateConfidence);
    expect(returnedGaps).toEqual(gaps);
    expect(digitalTwinEvents.emit).toHaveBeenCalledWith('interview:analyzed', { analysisResult });
  });
});
