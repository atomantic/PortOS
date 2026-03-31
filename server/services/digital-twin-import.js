import { getProviderById } from './providers.js';
import { buildPrompt } from './promptService.js';
import { safeJSONParse } from '../lib/fileUtils.js';
import { callProviderAI, now } from './digital-twin-helpers.js';
import { loadMeta } from './digital-twin-meta.js';
import { createDocument, updateDocument } from './digital-twin-documents.js';
import {
  getAllTwinContent,
  updateTraits,
  calculateConfidence,
  getGapRecommendations,
  parseTraitsResponse
} from './digital-twin-analysis.js';
import { digitalTwinEvents } from './digital-twin-meta.js';

/**
 * Parse Goodreads CSV export
 * CSV columns: Book Id, Title, Author, Author l-f, Additional Authors, ISBN, ISBN13,
 * My Rating, Average Rating, Publisher, Binding, Number of Pages, Year Published,
 * Original Publication Year, Date Read, Date Added, Bookshelves, Bookshelves with positions,
 * Exclusive Shelf, My Review, Spoiler, Private Notes, Read Count, Owned Copies
 */
function parseGoodreadsCSV(csvData) {
  const lines = csvData.split('\n');
  if (lines.length < 2) return [];

  // Parse header to find column indices
  const header = parseCSVLine(lines[0]);
  const titleIdx = header.findIndex(h => h.toLowerCase() === 'title');
  const authorIdx = header.findIndex(h => h.toLowerCase() === 'author');
  const ratingIdx = header.findIndex(h => h.toLowerCase() === 'my rating');
  const dateReadIdx = header.findIndex(h => h.toLowerCase() === 'date read');
  const shelvesIdx = header.findIndex(h => h.toLowerCase() === 'bookshelves');
  const reviewIdx = header.findIndex(h => h.toLowerCase() === 'my review');

  const books = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cols = parseCSVLine(lines[i]);

    const rating = ratingIdx >= 0 ? parseInt(cols[ratingIdx], 10) : 0;
    // Only include books that were actually read (have a rating > 0 or date read)
    if (rating > 0 || (dateReadIdx >= 0 && cols[dateReadIdx])) {
      books.push({
        title: cols[titleIdx] || '',
        author: cols[authorIdx] || '',
        rating: rating || undefined,
        dateRead: dateReadIdx >= 0 ? cols[dateReadIdx] : undefined,
        shelves: shelvesIdx >= 0 && cols[shelvesIdx] ? cols[shelvesIdx].split(',').map(s => s.trim()) : [],
        review: reviewIdx >= 0 ? cols[reviewIdx] : undefined
      });
    }
  }

  return books;
}

/**
 * Parse a CSV line handling quoted fields
 */
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());

  return result;
}

/**
 * Parse Spotify extended streaming history JSON
 * Spotify exports: endTime, artistName, trackName, msPlayed
 */
function parseSpotifyJSON(jsonData) {
  const data = safeJSONParse(jsonData, null, { logError: true, context: 'Spotify JSON import' });
  if (!data) return [];

  // Handle both array format and object with streams array
  const streams = Array.isArray(data) ? data : (data.streams || data);
  if (!Array.isArray(streams)) return [];

  // Aggregate by artist
  const artistCounts = new Map();
  const trackCounts = new Map();

  for (const entry of streams) {
    const artist = entry.artistName || entry.master_metadata_album_artist_name;
    const track = entry.trackName || entry.master_metadata_track_name;
    const msPlayed = entry.msPlayed || entry.ms_played || 0;

    if (artist) {
      const existing = artistCounts.get(artist) || { playCount: 0, msPlayed: 0 };
      artistCounts.set(artist, {
        playCount: existing.playCount + 1,
        msPlayed: existing.msPlayed + msPlayed
      });
    }

    if (track && artist) {
      const key = `${track}|||${artist}`;
      const existing = trackCounts.get(key) || { playCount: 0, msPlayed: 0 };
      trackCounts.set(key, {
        trackName: track,
        artistName: artist,
        playCount: existing.playCount + 1,
        msPlayed: existing.msPlayed + msPlayed
      });
    }
  }

  // Return top artists and tracks
  const topArtists = Array.from(artistCounts.entries())
    .map(([name, data]) => ({ artistName: name, ...data }))
    .sort((a, b) => b.msPlayed - a.msPlayed)
    .slice(0, 50);

  const topTracks = Array.from(trackCounts.values())
    .sort((a, b) => b.playCount - a.playCount)
    .slice(0, 50);

  return { artists: topArtists, tracks: topTracks };
}

/**
 * Parse Letterboxd CSV export
 */
function parseLetterboxdCSV(csvData) {
  const lines = csvData.split('\n');
  if (lines.length < 2) return [];

  const header = parseCSVLine(lines[0]);
  const nameIdx = header.findIndex(h => h.toLowerCase().includes('name') || h.toLowerCase() === 'title');
  const yearIdx = header.findIndex(h => h.toLowerCase() === 'year');
  const ratingIdx = header.findIndex(h => h.toLowerCase() === 'rating');
  const dateIdx = header.findIndex(h => h.toLowerCase().includes('watched'));
  const reviewIdx = header.findIndex(h => h.toLowerCase() === 'review');
  const tagsIdx = header.findIndex(h => h.toLowerCase() === 'tags');

  const films = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cols = parseCSVLine(lines[i]);

    films.push({
      title: cols[nameIdx] || cols[0] || '',
      year: yearIdx >= 0 && cols[yearIdx] ? parseInt(cols[yearIdx], 10) : undefined,
      rating: ratingIdx >= 0 && cols[ratingIdx] ? parseFloat(cols[ratingIdx]) : undefined,
      watchedDate: dateIdx >= 0 ? cols[dateIdx] : undefined,
      review: reviewIdx >= 0 ? cols[reviewIdx] : undefined,
      tags: tagsIdx >= 0 && cols[tagsIdx] ? cols[tagsIdx].split(',').map(t => t.trim()) : []
    });
  }

  return films.filter(f => f.title);
}

/**
 * Parse iCal/ICS calendar file
 */
function parseICalData(icsData) {
  const events = [];
  const eventBlocks = icsData.split('BEGIN:VEVENT');

  for (let i = 1; i < eventBlocks.length; i++) {
    const block = eventBlocks[i].split('END:VEVENT')[0];
    const event = {};

    const summaryMatch = block.match(/SUMMARY[^:]*:(.+?)(?:\r?\n(?![^\r\n])|\r?\n[A-Z])/s);
    if (summaryMatch) event.summary = summaryMatch[1].replace(/\r?\n\s/g, '').trim();

    const startMatch = block.match(/DTSTART[^:]*:(\d{8}T?\d{0,6})/);
    if (startMatch) event.start = startMatch[1];

    const endMatch = block.match(/DTEND[^:]*:(\d{8}T?\d{0,6})/);
    if (endMatch) event.end = endMatch[1];

    const rruleMatch = block.match(/RRULE:/);
    event.recurring = !!rruleMatch;

    const categoriesMatch = block.match(/CATEGORIES[^:]*:(.+?)(?:\r?\n[A-Z])/s);
    if (categoriesMatch) {
      event.categories = categoriesMatch[1].split(',').map(c => c.trim());
    }

    if (event.summary) {
      events.push(event);
    }
  }

  return events;
}

/**
 * Categorize calendar event by its summary
 */
function categorizeEvent(summary) {
  const lower = (summary || '').toLowerCase();
  if (lower.includes('meeting') || lower.includes('call') || lower.includes('sync')) return 'work';
  if (lower.includes('gym') || lower.includes('workout') || lower.includes('run') || lower.includes('yoga')) return 'fitness';
  if (lower.includes('doctor') || lower.includes('dentist') || lower.includes('appointment')) return 'health';
  if (lower.includes('dinner') || lower.includes('lunch') || lower.includes('coffee')) return 'social';
  if (lower.includes('class') || lower.includes('lesson') || lower.includes('course')) return 'learning';
  if (lower.includes('travel') || lower.includes('flight') || lower.includes('trip')) return 'travel';
  return 'other';
}

/**
 * Build fallback prompt for import analysis
 */
function buildImportAnalyzerPrompt(source, dataDescription) {
  const sourceLabels = {
    goodreads: 'reading history',
    spotify: 'music listening history',
    letterboxd: 'film watching history',
    ical: 'calendar/schedule patterns'
  };

  return `Analyze this ${sourceLabels[source] || source} data to understand the person's personality, values, and interests.

## Data
${dataDescription}

## Analysis Instructions
Based on this data, infer:

1. **Personality Traits (Big Five)**: What does their ${sourceLabels[source]} suggest about their Openness, Conscientiousness, Extraversion, Agreeableness, and Neuroticism? Provide estimates from 0.0 to 1.0.

2. **Values**: What values seem important to this person based on their choices?

3. **Interests & Themes**: What topics, genres, or themes do they gravitate toward?

4. **Patterns**: Any notable patterns in their behavior (e.g., variety vs. consistency, niche vs. mainstream)?

5. **Suggested Document Content**: Write a short markdown document summarizing key insights about their ${sourceLabels[source]} preferences.

## Output Format
Respond with JSON only:

\`\`\`json
{
  "insights": {
    "patterns": ["pattern 1", "pattern 2"],
    "preferences": ["preference 1", "preference 2"],
    "personalityInferences": {
      "bigFive": { "O": 0.7, "C": 0.6, "E": 0.5, "A": 0.6, "N": 0.4 },
      "values": ["value1", "value2"],
      "interests": ["interest1", "interest2"]
    }
  },
  "suggestedDocuments": [
    {
      "filename": "READING_PROFILE.md",
      "title": "Reading Profile",
      "category": "entertainment",
      "content": "# Reading Profile\\n\\nMarkdown content here..."
    }
  ],
  "rawSummary": "2-3 sentence summary of what this data reveals about the person"
}
\`\`\``;
}

/**
 * Send prompt to AI and parse response
 */
async function analyzeWithPrompt(prompt, providerId, model, source, parsedData) {
  const provider = await getProviderById(providerId);
  if (!provider || !provider.enabled) {
    return { error: 'Provider not found or disabled' };
  }

  const result = await callProviderAI(provider, model, prompt, { temperature: 0.4, max_tokens: 3000 });
  if (!result.error && result.text) {
    return parseImportAnalysisResponse(result.text, source, parsedData);
  }

  return { error: result.error || 'Provider request failed' };
}

/**
 * Parse AI response for import analysis
 */
function parseImportAnalysisResponse(response, source, parsedData) {
  const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    const parsed = safeJSONParse(jsonMatch[1], null, { logError: true, context: 'import analysis' });
    if (parsed) {
      return {
        source,
        itemCount: Array.isArray(parsedData) ? parsedData.length : (parsedData.artists?.length || 0),
        ...parsed
      };
    }
  }

  if (response.trim().startsWith('{')) {
    const parsed = safeJSONParse(response, null, { logError: true, context: 'import analysis fallback' });
    if (parsed) {
      return {
        source,
        itemCount: Array.isArray(parsedData) ? parsedData.length : (parsedData.artists?.length || 0),
        ...parsed
      };
    }
  }

  return {
    source,
    itemCount: Array.isArray(parsedData) ? parsedData.length : (parsedData.artists?.length || 0),
    insights: { patterns: [], preferences: [] },
    rawSummary: response
  };
}

/**
 * Analyze imported data and extract personality insights
 */
export async function analyzeImportedData(source, rawData, providerId, model) {
  let parsedData;
  let dataDescription;

  // Parse based on source
  switch (source) {
    case 'goodreads': {
      parsedData = parseGoodreadsCSV(rawData);
      if (parsedData.length === 0) {
        return { error: 'No books found in Goodreads export. Make sure you exported your library.' };
      }
      const topRated = parsedData.filter(b => b.rating >= 4).slice(0, 20);
      const authors = [...new Set(parsedData.map(b => b.author).filter(Boolean))].slice(0, 20);
      const shelves = [...new Set(parsedData.flatMap(b => b.shelves || []))].slice(0, 15);
      dataDescription = `Reading History (${parsedData.length} books):\n` +
        `Top-rated books: ${topRated.map(b => `"${b.title}" by ${b.author} (${b.rating}/5)`).join(', ')}\n` +
        `Favorite authors: ${authors.join(', ')}\n` +
        `Shelves/genres: ${shelves.join(', ')}\n` +
        `Sample reviews: ${parsedData.filter(b => b.review).slice(0, 3).map(b => `"${b.title}": ${b.review?.substring(0, 200)}...`).join('\n')}`;
      break;
    }

    case 'spotify': {
      parsedData = parseSpotifyJSON(rawData);
      if (!parsedData.artists || parsedData.artists.length === 0) {
        return { error: 'No listening data found in Spotify export.' };
      }
      const topArtists = parsedData.artists.slice(0, 15);
      const topTracks = parsedData.tracks?.slice(0, 15) || [];
      const totalHours = Math.round(topArtists.reduce((sum, a) => sum + a.msPlayed, 0) / 3600000);
      dataDescription = `Listening History (${totalHours} hours tracked):\n` +
        `Top artists: ${topArtists.map(a => `${a.artistName} (${Math.round(a.msPlayed / 60000)} min)`).join(', ')}\n` +
        `Top tracks: ${topTracks.map(t => `"${t.trackName}" by ${t.artistName}`).join(', ')}`;
      break;
    }

    case 'letterboxd': {
      parsedData = parseLetterboxdCSV(rawData);
      if (parsedData.length === 0) {
        return { error: 'No films found in Letterboxd export.' };
      }
      const topRated = parsedData.filter(f => f.rating >= 4).slice(0, 20);
      const tags = [...new Set(parsedData.flatMap(f => f.tags || []))].slice(0, 15);
      dataDescription = `Film History (${parsedData.length} films):\n` +
        `Top-rated films: ${topRated.map(f => `"${f.title}" (${f.year}) - ${f.rating}/5`).join(', ')}\n` +
        `Tags/themes: ${tags.join(', ')}\n` +
        `Sample reviews: ${parsedData.filter(f => f.review).slice(0, 3).map(f => `"${f.title}": ${f.review?.substring(0, 200)}...`).join('\n')}`;
      break;
    }

    case 'ical': {
      parsedData = parseICalData(rawData);
      if (parsedData.length === 0) {
        return { error: 'No events found in calendar export.' };
      }
      const recurring = parsedData.filter(e => e.recurring);
      const categories = [...new Set(parsedData.flatMap(e => e.categories || []))];
      const eventTypes = {};
      parsedData.forEach(e => {
        const type = categorizeEvent(e.summary);
        eventTypes[type] = (eventTypes[type] || 0) + 1;
      });
      dataDescription = `Calendar Analysis (${parsedData.length} events, ${recurring.length} recurring):\n` +
        `Event types: ${Object.entries(eventTypes).map(([k, v]) => `${k}: ${v}`).join(', ')}\n` +
        `Categories: ${categories.join(', ')}\n` +
        `Recurring commitments: ${recurring.slice(0, 10).map(e => e.summary).join(', ')}`;
      break;
    }

    default:
      return { error: `Unknown import source: ${source}` };
  }

  // Build analysis prompt
  const prompt = await buildPrompt('twin-import-analyzer', {
    source,
    dataDescription,
    itemCount: Array.isArray(parsedData) ? parsedData.length : (parsedData.artists?.length || 0)
  }).catch(() => null);

  if (!prompt) {
    // Fallback to inline prompt
    const fallbackPrompt = buildImportAnalyzerPrompt(source, dataDescription);
    return analyzeWithPrompt(fallbackPrompt, providerId, model, source, parsedData);
  }

  return analyzeWithPrompt(prompt, providerId, model, source, parsedData);
}

/**
 * Save imported analysis as a document
 */
export async function saveImportAsDocument(source, suggestedDoc) {
  const { filename, title, category, content } = suggestedDoc;

  // Check if document already exists
  const meta = await loadMeta();
  const existingDoc = meta.documents.find(d => d.filename === filename);

  if (existingDoc) {
    // Update existing document
    return updateDocument(existingDoc.id, { content, title });
  }

  // Create new document
  return createDocument({
    filename,
    title,
    category,
    content,
    enabled: true,
    priority: 5
  });
}

/**
 * Get list of supported import sources
 */
export function getImportSources() {
  return [
    {
      id: 'goodreads',
      name: 'Goodreads',
      description: 'Import your reading history to analyze literary preferences and themes',
      format: 'CSV',
      instructions: 'Go to My Books > Import/Export > Export Library. Download the CSV file.'
    },
    {
      id: 'spotify',
      name: 'Spotify',
      description: 'Import listening history to analyze music preferences and emotional patterns',
      format: 'JSON',
      instructions: 'Go to Account > Privacy Settings > Download your data. Request "Extended streaming history". Extract the JSON files.'
    },
    {
      id: 'letterboxd',
      name: 'Letterboxd',
      description: 'Import film diary to analyze viewing preferences and aesthetic tastes',
      format: 'CSV',
      instructions: 'Go to Settings > Import & Export > Export Your Data. Download the diary.csv or films.csv.'
    },
    {
      id: 'ical',
      name: 'Calendar (iCal)',
      description: 'Import calendar to analyze routine patterns and time allocation',
      format: 'ICS',
      instructions: 'Export your calendar as .ics file from Google Calendar, Apple Calendar, or Outlook.'
    }
  ];
}

/**
 * Analyze a pasted personality assessment without session management.
 * Extracts traits, creates/updates documents, and returns gap recommendations.
 */
export async function analyzeAssessment(content, providerId, model) {
  console.log(`🧪 [${now()}] Assessment analysis: provider=${providerId}, model=${model}, content=${content.length} chars`);

  // 1. Load twin context
  const twinContent = await getAllTwinContent();
  const meta = await loadMeta();
  const currentTraits = meta.traits || {};
  const confidenceBefore = meta.confidence?.overall || 0;

  // 2. Build analysis prompt
  const analysisPrompt = await buildPrompt('twin-interview-analyze', {
    twinContent: twinContent || 'No existing twin documents yet.',
    currentTraits: JSON.stringify(currentTraits, null, 2) || '{}',
    pastedContent: content
  }).catch(() => null);

  if (!analysisPrompt) {
    return { error: 'Analysis prompt template not found' };
  }

  const provider = await getProviderById(providerId);
  if (!provider || !provider.enabled) {
    return { error: 'Provider not found or disabled' };
  }

  // 3. Call AI for analysis
  console.log(`🧪 [${now()}] Calling ${provider.name} (${model}), prompt=${analysisPrompt.length} chars`);
  const aiResponse = await callProviderAI(provider, model, analysisPrompt, { temperature: 0.3, max_tokens: 4000 });

  if (aiResponse.error) {
    return { error: aiResponse.error };
  }

  const parsed = parseTraitsResponse(aiResponse.text);
  if (parsed.error) {
    return { error: parsed.error };
  }

  // 4. Apply trait updates
  const traitUpdates = {};
  if (parsed.bigFive) traitUpdates.bigFive = parsed.bigFive;
  if (parsed.valuesHierarchy) traitUpdates.valuesHierarchy = parsed.valuesHierarchy;
  if (parsed.communicationProfile) traitUpdates.communicationProfile = parsed.communicationProfile;

  if (Object.keys(traitUpdates).length > 0) {
    await updateTraits(traitUpdates);
  }

  // 5. Create/update documents from suggestions
  const docsCreated = [];
  const docsUpdated = [];
  for (const doc of (parsed.suggestedDocuments || [])) {
    if (!doc.filename || !doc.content) continue;
    const currentMeta = await loadMeta();
    const existsBefore = currentMeta.documents.some(d => d.filename === doc.filename);
    const result = await saveImportAsDocument('interview', {
      filename: doc.filename,
      title: doc.title || doc.filename.replace('.md', ''),
      category: doc.category || 'enrichment',
      content: doc.content
    });
    if (result) {
      (existsBefore ? docsUpdated : docsCreated).push(doc.filename);
    }
  }

  // 6. Recalculate confidence with updated content and traits
  const confidenceResult = await calculateConfidence();
  const confidenceAfter = confidenceResult.confidence?.overall || confidenceBefore;

  // 7. Get gap recommendations
  const gaps = await getGapRecommendations();

  const analysisResult = {
    traitsUpdated: traitUpdates,
    documentsCreated: docsCreated,
    documentsUpdated: docsUpdated,
    newDimensions: parsed.newDimensions || [],
    confidenceDelta: { before: confidenceBefore, after: confidenceAfter },
    summary: parsed.summary || 'Analysis complete. Twin profile updated.'
  };

  digitalTwinEvents.emit('interview:analyzed', { analysisResult });
  console.log(`🧪 [${now()}] Assessment complete: ${docsCreated.length} created, ${docsUpdated.length} updated, ${Object.keys(traitUpdates).length} trait categories`);

  return { analysisResult, gaps };
}
