/**
 * BM25 (Best Matching 25) Algorithm Implementation
 *
 * A ranking function used for text retrieval that considers:
 * - Term frequency (TF): How often a term appears in a document
 * - Inverse document frequency (IDF): How rare/important a term is across all documents
 * - Document length normalization: Penalizes longer documents fairly
 *
 * @see https://en.wikipedia.org/wiki/Okapi_BM25
 */

// Default BM25 parameters
const DEFAULT_K1 = 1.5  // Term frequency saturation parameter (1.2-2.0 typical)
const DEFAULT_B = 0.75  // Document length normalization (0 = no normalization, 1 = full)

/**
 * Tokenize text into terms for indexing
 * @param {string} text - Text to tokenize
 * @returns {string[]} - Array of lowercase terms
 */
function tokenize(text) {
  if (!text || typeof text !== 'string') return []

  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')  // Replace punctuation with spaces
    .split(/\s+/)               // Split on whitespace
    .filter(term => term.length > 1)  // Remove single characters
    .filter(term => !STOP_WORDS.has(term))  // Remove stop words
}

/**
 * Common English stop words to exclude from indexing
 */
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from',
  'has', 'he', 'in', 'is', 'it', 'its', 'of', 'on', 'or', 'that',
  'the', 'to', 'was', 'were', 'will', 'with', 'this', 'but', 'they',
  'have', 'had', 'what', 'when', 'where', 'who', 'which', 'why', 'how',
  'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other',
  'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so',
  'than', 'too', 'very', 'just', 'can', 'should', 'now', 'into',
  'would', 'could', 'also', 'been', 'being', 'do', 'does', 'did'
])

/**
 * Calculate IDF (Inverse Document Frequency) for a term
 * Uses the BM25 IDF formula: log((N - n + 0.5) / (n + 0.5) + 1)
 *
 * @param {number} N - Total number of documents
 * @param {number} n - Number of documents containing the term
 * @returns {number} - IDF value
 */
function calculateIDF(N, n) {
  if (n === 0 || N === 0) return 0
  return Math.log((N - n + 0.5) / (n + 0.5) + 1)
}

/**
 * Build an inverted index from documents
 *
 * @param {Array<{id: string, text: string}>} documents - Documents to index
 * @returns {Object} - Inverted index structure
 */
function buildInvertedIndex(documents) {
  const index = {
    terms: {},           // term -> { docFreq, postings: { docId -> termFreq } }
    docLengths: {},      // docId -> number of terms
    avgDocLength: 0,     // Average document length
    totalDocs: 0,        // Total number of documents
    docIds: new Set()    // Set of all document IDs
  }

  let totalTerms = 0

  for (const doc of documents) {
    if (!doc.id || !doc.text) continue

    const terms = tokenize(doc.text)
    const docId = doc.id

    index.docIds.add(docId)
    index.docLengths[docId] = terms.length
    totalTerms += terms.length

    // Count term frequencies in this document
    const termFreqs = {}
    for (const term of terms) {
      termFreqs[term] = (termFreqs[term] || 0) + 1
    }

    // Update inverted index
    for (const [term, freq] of Object.entries(termFreqs)) {
      if (!index.terms[term]) {
        index.terms[term] = { docFreq: 0, postings: {} }
      }

      if (!index.terms[term].postings[docId]) {
        index.terms[term].docFreq++
      }
      index.terms[term].postings[docId] = freq
    }
  }

  index.totalDocs = index.docIds.size
  index.avgDocLength = index.totalDocs > 0 ? totalTerms / index.totalDocs : 0

  return index
}

/**
 * Add a single document to an existing index
 *
 * @param {Object} index - Existing inverted index
 * @param {string} docId - Document ID
 * @param {string} text - Document text
 * @returns {Object} - Updated index
 */
function addDocument(index, docId, text) {
  if (!docId || !text) return index

  // Remove existing if updating
  if (index.docIds.has(docId)) {
    removeDocument(index, docId)
  }

  const terms = tokenize(text)

  index.docIds.add(docId)
  index.docLengths[docId] = terms.length

  // Update average document length
  const oldTotal = index.avgDocLength * index.totalDocs
  index.totalDocs = index.docIds.size
  index.avgDocLength = (oldTotal + terms.length) / index.totalDocs

  // Count term frequencies
  const termFreqs = {}
  for (const term of terms) {
    termFreqs[term] = (termFreqs[term] || 0) + 1
  }

  // Update inverted index
  for (const [term, freq] of Object.entries(termFreqs)) {
    if (!index.terms[term]) {
      index.terms[term] = { docFreq: 0, postings: {} }
    }

    if (!index.terms[term].postings[docId]) {
      index.terms[term].docFreq++
    }
    index.terms[term].postings[docId] = freq
  }

  return index
}

/**
 * Remove a document from the index
 *
 * @param {Object} index - Existing inverted index
 * @param {string} docId - Document ID to remove
 * @returns {Object} - Updated index
 */
function removeDocument(index, docId) {
  if (!index.docIds.has(docId)) return index

  const docLength = index.docLengths[docId] || 0

  // Update average document length
  const oldTotal = index.avgDocLength * index.totalDocs
  index.docIds.delete(docId)
  index.totalDocs = index.docIds.size

  if (index.totalDocs > 0) {
    index.avgDocLength = (oldTotal - docLength) / index.totalDocs
  } else {
    index.avgDocLength = 0
  }

  delete index.docLengths[docId]

  // Remove from inverted index
  for (const term of Object.keys(index.terms)) {
    if (index.terms[term].postings[docId]) {
      delete index.terms[term].postings[docId]
      index.terms[term].docFreq--

      // Clean up empty terms
      if (index.terms[term].docFreq === 0) {
        delete index.terms[term]
      }
    }
  }

  return index
}

/**
 * Calculate BM25 score for a query against a document
 *
 * @param {string} query - Search query
 * @param {string} docId - Document ID to score
 * @param {Object} index - Inverted index
 * @param {Object} options - BM25 parameters
 * @returns {number} - BM25 score
 */
function score(query, docId, index, options = {}) {
  const k1 = options.k1 ?? DEFAULT_K1
  const b = options.b ?? DEFAULT_B

  if (!index.docIds.has(docId)) return 0

  const queryTerms = tokenize(query)
  const docLength = index.docLengths[docId] || 0
  const avgDocLength = index.avgDocLength || 1
  const N = index.totalDocs

  let totalScore = 0

  for (const term of queryTerms) {
    const termData = index.terms[term]
    if (!termData) continue

    const tf = termData.postings[docId] || 0
    if (tf === 0) continue

    const idf = calculateIDF(N, termData.docFreq)

    // BM25 term score formula
    const numerator = tf * (k1 + 1)
    const denominator = tf + k1 * (1 - b + b * (docLength / avgDocLength))

    totalScore += idf * (numerator / denominator)
  }

  return totalScore
}

/**
 * Search the index for documents matching a query
 *
 * @param {string} query - Search query
 * @param {Object} index - Inverted index
 * @param {Object} options - Search options
 * @param {number} options.limit - Maximum results to return
 * @param {number} options.threshold - Minimum score threshold
 * @param {number} options.k1 - BM25 k1 parameter
 * @param {number} options.b - BM25 b parameter
 * @returns {Array<{docId: string, score: number}>} - Ranked results
 */
function search(query, index, options = {}) {
  const { limit = 10, threshold = 0, k1 = DEFAULT_K1, b = DEFAULT_B } = options

  const queryTerms = tokenize(query)
  if (queryTerms.length === 0) return []

  // Find candidate documents (those containing at least one query term)
  const candidates = new Set()
  for (const term of queryTerms) {
    const termData = index.terms[term]
    if (termData) {
      for (const docId of Object.keys(termData.postings)) {
        candidates.add(docId)
      }
    }
  }

  // Score all candidates
  const results = []
  for (const docId of candidates) {
    const docScore = score(query, docId, index, { k1, b })
    if (docScore > threshold) {
      results.push({ docId, score: docScore })
    }
  }

  // Sort by score descending and apply limit
  results.sort((a, b) => b.score - a.score)
  return results.slice(0, limit)
}

/**
 * Create an empty index structure
 * @returns {Object} - Empty index
 */
function createEmptyIndex() {
  return {
    terms: {},
    docLengths: {},
    avgDocLength: 0,
    totalDocs: 0,
    docIds: new Set()
  }
}

/**
 * Serialize index for persistence (converts Set to Array)
 * @param {Object} index - Index to serialize
 * @returns {Object} - Serializable index
 */
function serializeIndex(index) {
  return {
    ...index,
    docIds: Array.from(index.docIds)
  }
}

/**
 * Deserialize index from storage (converts Array back to Set)
 * @param {Object} data - Serialized index data
 * @returns {Object} - Usable index
 */
function deserializeIndex(data) {
  if (!data) return createEmptyIndex()

  return {
    terms: data.terms || {},
    docLengths: data.docLengths || {},
    avgDocLength: data.avgDocLength || 0,
    totalDocs: data.totalDocs || 0,
    docIds: new Set(data.docIds || [])
  }
}

/**
 * Get index statistics
 * @param {Object} index - The index
 * @returns {Object} - Statistics about the index
 */
function getIndexStats(index) {
  return {
    totalDocuments: index.totalDocs,
    totalTerms: Object.keys(index.terms).length,
    avgDocumentLength: Math.round(index.avgDocLength * 100) / 100
  }
}

export {
  tokenize,
  calculateIDF,
  buildInvertedIndex,
  addDocument,
  removeDocument,
  score,
  search,
  createEmptyIndex,
  serializeIndex,
  deserializeIndex,
  getIndexStats,
  STOP_WORDS,
  DEFAULT_K1,
  DEFAULT_B
}
