# Unified Digital Twin Identity System (M42)

Connects Genome (117 markers, 32 categories), Chronotype (5 sleep markers + behavioral), Aesthetic Taste (P2 complete, P2.5 adds twin-aware prompting), and Mortality-Aware Goals into a single coherent Identity architecture with cross-insights engine.

## Motivation

Four separate workstreams converge on the same vision: a personal digital twin that knows *who you are* biologically, temporally, aesthetically, and existentially. Today these live as disconnected features:

| Subsystem | Current State | Location |
|-----------|--------------|----------|
| **Genome** | Fully implemented: 23andMe upload, 117 curated SNP markers across 32 categories, ClinVar integration, epigenetic tracking | `server/services/genome.js`, `GenomeTab.jsx`, `data/digital-twin/genome.json` |
| **Chronotype** | Genetic data ready: 5 sleep/circadian markers (CLOCK rs1801260, DEC2 rs57875989, PER2 rs35333999, CRY1 rs2287161, MTNR1B rs10830963) + `daily_routines` enrichment category. Derivation service not yet built | `curatedGenomeMarkers.js` sleep category, `ENRICHMENT_CATEGORIES.daily_routines` |
| **Aesthetic Taste** | P2 complete: Taste questionnaire with 5 sections (movies, music, visual_art, architecture, food), conversational Q&A, AI summary generation. Enrichment categories also feed taste data from book/movie/music lists | `TasteTab.jsx`, `taste-questionnaire.js`, `data/digital-twin/taste-profile.json` |
| **Goal Tracking** | Partially exists: `COS-GOALS.md` for CoS missions, `TASKS.md` for user tasks, `EXISTENTIAL.md` soul doc | `data/COS-GOALS.md`, `data/TASKS.md`, `data/digital-twin/EXISTENTIAL.md` |

These should be unified under a single **Identity** architecture so the twin can reason across all dimensions (e.g., "your CLOCK gene says evening chronotype — schedule deep work after 8pm" or "given your longevity markers and age, here's how to prioritize your 10-year goals").

## Data Model

### Entity: `identity.json` (top-level twin orchestration)

```json
{
  "version": "1.0.0",
  "createdAt": "2026-02-12T00:00:00.000Z",
  "updatedAt": "2026-02-12T00:00:00.000Z",
  "sections": {
    "genome": { "status": "active", "dataFile": "genome.json", "markerCount": 117, "categoryCount": 32, "lastScanAt": "..." },
    "chronotype": { "status": "active", "dataFile": "chronotype.json", "derivedFrom": ["genome:sleep", "enrichment:daily_routines"] },
    "aesthetics": { "status": "active", "dataFile": "aesthetics.json", "derivedFrom": ["enrichment:aesthetics", "enrichment:favorite_books", "enrichment:favorite_movies", "enrichment:music_taste"] },
    "goals": { "status": "active", "dataFile": "goals.json" }
  },
  "crossLinks": []
}
```

### Entity: Chronotype Profile (`chronotype.json`)

Derived from genome sleep markers + daily_routines enrichment answers + user overrides.

```json
{
  "chronotype": "evening",
  "confidence": 0.75,
  "sources": {
    "genetic": {
      "clockGene": { "rsid": "rs1801260", "genotype": "T/C", "signal": "mild_evening" },
      "dec2": { "rsid": "rs57875989", "genotype": "G/G", "signal": "standard_sleep_need" },
      "per2": { "rsid": "rs35333999", "genotype": "C/C", "signal": "standard_circadian" },
      "cry1": { "rsid": "rs2287161", "genotype": "C/C", "signal": "standard_period" },
      "mtnr1b": { "rsid": "rs10830963", "genotype": "T/T", "signal": "normal_melatonin_receptor" }
    },
    "behavioral": {
      "preferredWakeTime": "08:30",
      "preferredSleepTime": "00:30",
      "peakFocusWindow": "20:00-02:00",
      "energyDipWindow": "14:00-16:00"
    }
  },
  "recommendations": {
    "deepWork": "20:00-02:00",
    "lightTasks": "09:00-12:00",
    "exercise": "17:00-19:00",
    "caffeineCutoff": "14:00"
  },
  "updatedAt": "2026-02-12T00:00:00.000Z"
}
```

**Derivation logic**: Five genome sleep markers provide the genetic baseline: CLOCK (evening preference), DEC2 (sleep duration need), PER2 (circadian period), CRY1 (delayed sleep phase), MTNR1B (melatonin receptor / nighttime glucose). The `daily_routines` enrichment answers provide behavioral confirmation. When genetic and behavioral signals agree, confidence is high. When they disagree, surface the conflict for user review. Caffeine cutoff cross-references caffeine metabolism markers (CYP1A2 rs762551, ADA rs73598374). MTNR1B status also informs late-eating recommendations.

### Entity: Aesthetic Taste Profile (`aesthetics.json`)

Consolidates scattered aesthetic data into a structured profile.

```json
{
  "profile": {
    "visualStyle": [],
    "narrativePreferences": [],
    "musicProfile": [],
    "designPrinciples": [],
    "antiPatterns": []
  },
  "sources": {
    "enrichmentAnswers": { "aesthetics": "...", "questionsAnswered": 0 },
    "bookAnalysis": { "themes": [], "sourceDoc": "BOOKS.md" },
    "movieAnalysis": { "themes": [], "sourceDoc": "MOVIES.md" },
    "musicAnalysis": { "themes": [], "sourceDoc": "AUDIO.md" }
  },
  "questionnaire": {
    "completed": false,
    "sections": [
      "visual_design",
      "color_and_mood",
      "architecture_and_space",
      "fashion_and_texture",
      "sound_and_music",
      "narrative_and_story",
      "anti_preferences"
    ]
  },
  "updatedAt": null
}
```

**Derivation logic**: Taste is partially observable from existing enrichment data (book/movie/music lists). The aesthetic questionnaire fills in the rest via prompted sections — each section shows image/description pairs and asks for preference rankings. LLM analysis of existing media lists extracts themes (e.g., "brutalist minimalism", "high-contrast neon", "atmospheric dread") to seed the profile.

### Entity: Mortality-Aware Goals (`goals.json`)

```json
{
  "birthDate": "1980-01-15",
  "lifeExpectancyEstimate": {
    "baseline": 78.5,
    "adjusted": null,
    "adjustmentFactors": {
      "geneticLongevity": null,
      "cardiovascularRisk": null,
      "lifestyle": null
    },
    "source": "SSA actuarial table + genome markers"
  },
  "timeHorizons": {
    "yearsRemaining": null,
    "healthyYearsRemaining": null,
    "percentLifeComplete": null
  },
  "goals": [
    {
      "id": "uuid",
      "title": "...",
      "description": "...",
      "horizon": "5-year",
      "category": "creative|family|health|financial|legacy|mastery",
      "urgency": null,
      "status": "active|completed|abandoned",
      "milestones": [],
      "createdAt": "...",
      "updatedAt": "..."
    }
  ],
  "updatedAt": null
}
```

**Derivation logic**: Birth date + actuarial baseline + genome longevity/cardiovascular markers produce an adjusted life expectancy. This creates urgency scoring: a "legacy" goal with a 20-year timeline hits differently at 30% life-complete vs 70%. Goals are categorized and scored by time-decay urgency. The system can suggest reprioritization when markers indicate risk factors (e.g., high cardiovascular genetic risk -> prioritize health goals).

## Entity Relationships

```
                    +------------------+
                    |   identity.json  |
                    |  (orchestrator)  |
                    +--+---+---+---+--+
                       |   |   |   |
            +----------+   |   |   +----------+
            v              v   v              v
     +---------+   +----------+  +----------+  +---------+
     | Genome  |   |Chronotype|  |Aesthetics|  |  Goals  |
     |genome.json| |chrono.json| |aesth.json|  |goals.json|
     +----+----+   +----+-----+  +----+-----+  +----+----+
          |              |             |              |
          |    +---------+             |              |
          |    | derives from          |              |
          +----+ sleep markers         |              |
          |    |                       |              |
          |    | caffeine cutoff <-----+              |
          |    | from caffeine markers |              |
          |    |                       |              |
          |    +-----------------------+              |
          |                            |              |
          |    longevity/cardio ---------------------->|
          |    markers inform          |    urgency   |
          |    life expectancy         |    scoring   |
          |                            |              |
          |              +-------------+              |
          |              | derives from               |
          |              | enrichment: aesthetics,     |
          |              | books, movies, music        |
          |              |                            |
          +--------------+----------------------------+
                    All reference meta.json
                    (documents, enrichment, traits)
```

**Cross-cutting links** (stored in `identity.json.crossLinks`):
- `genome:sleep` -> `chronotype:genetic` (CLOCK/DEC2/PER2/CRY1/MTNR1B markers feed chronotype)
- `genome:caffeine` -> `chronotype:recommendations.caffeineCutoff` (CYP1A2/ADA markers set cutoff)
- `genome:sleep:mtnr1b` -> `chronotype:recommendations.lateEatingCutoff` (MTNR1B impairs nighttime glucose)
- `genome:longevity` + `genome:cardiovascular` -> `goals:lifeExpectancyEstimate` (risk-adjusted lifespan)
- `enrichment:daily_routines` -> `chronotype:behavioral` (self-reported schedule)
- `enrichment:aesthetics` + `enrichment:favorite_*` + `enrichment:music_taste` -> `aesthetics:profile` (taste extraction)
- `traits:valuesHierarchy` -> `goals:category` priority weighting (autonomy-valuing person weights mastery goals higher)

## Identity Page Structure

The existing Digital Twin page at `/digital-twin/:tab` gets a new **Identity** tab that serves as the unified view. Individual subsystem tabs (Genome, Enrich) remain for deep dives.

### Route: `/digital-twin/identity`

```
+-------------------------------------------------------------+
| Digital Twin                                                |
| Overview | Documents | ... | Identity | Genome | ...        |
+-------------------------------------------------------------+
|                                                             |
|  +- Identity Dashboard --------------------------------+  |
|  |  Completeness: xxxxxxxx.. 72%                       |  |
|  |  4 sections: Genome Y  Chronotype ~  Taste .  Goals .|  |
|  +-----------------------------------------------------+  |
|                                                             |
|  +- Genome Summary Card -------------------------------+  |
|  |  117 markers scanned across 32 categories           |  |
|  |  Key findings: ~20 beneficial, ~40 concern, ~5 major|  |
|  |  [View Full Genome ->]                              |  |
|  +-----------------------------------------------------+  |
|                                                             |
|  +- Chronotype Card -----------------------------------+  |
|  |  Type: Evening Owl (75% confidence from 5 markers)  |  |
|  |  Genetic: CLOCK T/C + CRY1 C/C + PER2 C/C + DEC2 G|  |
|  |  Peak focus: 8pm-2am | Caffeine cutoff: 2pm        |  |
|  |  Late eating cutoff: 8pm (MTNR1B-informed)          |  |
|  |  [Configure Schedule ->]                            |  |
|  +-----------------------------------------------------+  |
|                                                             |
|  +- Aesthetic Taste Card -------------------------------+  |
|  |  Taste Tab: 0/5 sections completed (P2 UI ready)    |  |
|  |  Detected themes from media: brutalist, atmospheric  |  |
|  |  [Continue Taste Questionnaire ->] [Go to Taste ->]  |  |
|  +-----------------------------------------------------+  |
|                                                             |
|  +- Life Goals Card -----------------------------------+  |
|  |  Status: Not configured                             |  |
|  |  Set birth date and goals to enable mortality-aware  |  |
|  |  priority scoring                                   |  |
|  |  [Set Up Goals ->]                                  |  |
|  +-----------------------------------------------------+  |
|                                                             |
|  +- Cross-Insights ------------------------------------+  |
|  |  "Your CLOCK gene evening tendency + caffeine        |  |
|  |   sensitivity suggest cutting coffee by 2pm"         |  |
|  |  "Longevity marker FOXO3A T/T (concern) + IL-6 C/C  |  |
|  |   (inflammation concern) -- prioritize health goals" |  |
|  +-----------------------------------------------------+  |
|                                                             |
+-------------------------------------------------------------+
```

### Sub-routes for deep dives:
- `/digital-twin/identity` -- Dashboard overview (above)
- `/digital-twin/identity/chronotype` -- Full chronotype editor with schedule builder
- `/digital-twin/identity/taste` -- Aesthetic questionnaire flow (section-by-section)
- `/digital-twin/identity/goals` -- Goal CRUD with urgency visualization
- `/digital-twin/genome` -- Existing genome tab (unchanged)

## Implementation Phases

### P1: Identity Orchestrator & Chronotype (data layer)
- Create `data/digital-twin/identity.json` with section status tracking
- Create `server/services/identity.js` -- orchestrator that reads from genome, enrichment, taste-profile, and new data files
- Create `data/digital-twin/chronotype.json` -- derive from 5 genome sleep markers + daily_routines enrichment
- Add `GET /api/digital-twin/identity` route returning unified section status
- Add `GET/PUT /api/digital-twin/identity/chronotype` routes
- Derivation function: `deriveChronotypeFromGenome(genomeSummary)` extracts all 5 sleep markers (CLOCK, DEC2, PER2, CRY1, MTNR1B) -> composite chronotype signal with weighted confidence
- Cross-reference CYP1A2/ADA caffeine markers and MTNR1B melatonin receptor for caffeine cutoff and late-eating recommendations

### P2: Aesthetic Taste Questionnaire (complete)
- Created `data/digital-twin/taste-profile.json` for structured taste preference storage
- Created `server/services/taste-questionnaire.js` with 5 taste sections (movies, music, visual_art, architecture, food), each with core questions and branching follow-ups triggered by keyword detection
- Added 7 API routes under `/api/digital-twin/taste/*` (profile, sections, next question, answer, responses, summary, reset)
- Built `TasteTab.jsx` conversational Q&A UI with section grid, question flow, review mode, and AI-powered summary generation
- Responses persisted to taste-profile.json and appended to AESTHETICS.md for digital twin context
- Added Taste tab to Digital Twin page navigation

### P2.5: Digital Twin Aesthetic Taste Prompting (brain idea 608dc733)

#### Problem

P2's Taste questionnaire uses static questions and keyword-triggered follow-ups. The questions are good but generic -- they don't reference anything the twin already knows about the user. Brain idea 608dc733 proposes using the digital twin's existing knowledge (books, music, movie lists, enrichment answers, personality traits) to generate personalized, conversational prompts that feel like talking to someone who already knows you rather than filling out a survey.

#### What Data to Capture

The aesthetic taste system captures preferences across **7 domains**, extending P2's 5 sections with 2 new ones (fashion/texture and digital/interface):

| Domain | Data Captured | Sources That Seed It |
|--------|--------------|---------------------|
| **Movies & Film** | Visual style preferences, narrative structure, mood/atmosphere, genre affinities, anti-preferences, formative films | BOOKS.md (narrative taste), enrichment:favorite_movies, existing P2 responses |
| **Music & Sound** | Functional use (focus/energy/decompress), genre affinities, production preferences, anti-sounds, formative artists | AUDIO.md, enrichment:music_taste, existing P2 responses |
| **Visual Art & Design** | Minimalism vs maximalism spectrum, color palette preferences, design movements, typography, layout sensibility | CREATIVE.md, enrichment:aesthetics, existing P2 responses |
| **Architecture & Spaces** | Material preferences, light quality, scale/intimacy, indoor-outdoor relationship, sacred vs functional | enrichment:aesthetics, existing P2 responses |
| **Food & Culinary** | Flavor profiles, cuisine affinities, cooking philosophy, dining experience priorities, sensory texture preferences | enrichment:daily_routines (meal patterns), existing P2 responses |
| **Fashion & Texture** *(new)* | Material/fabric preferences, silhouette comfort, color wardrobe, formality spectrum, tactile sensitivity | genome:sensory markers (if available), enrichment:aesthetics |
| **Digital & Interface** *(new)* | Dark vs light mode, information density, animation tolerance, typography preferences, notification style, tool aesthetics | PREFERENCES.md, existing PortOS theme choices (port-bg, port-card etc.) |

Each domain captures:
- **Positive affinities** -- what they're drawn to and why
- **Anti-preferences** -- what they actively avoid (often more revealing than likes)
- **Functional context** -- how the preference serves them (focus, comfort, identity, social)
- **Formative influences** -- early experiences that shaped the preference
- **Evolution** -- how the preference has changed over time

#### Conversational Prompting Flow

The key design principle: **conversation, not survey**. The twin generates questions that reference things it already knows, creating a dialogue that feels like it's building on shared context.

**Flow architecture:**

```
+---------------------------------------------------+
| 1. Context Aggregation                            |
|    Read: BOOKS.md, AUDIO.md, CREATIVE.md,         |
|    PREFERENCES.md, enrichment answers,            |
|    existing taste-profile.json responses,         |
|    personality traits (Big Five Openness)          |
+---------------------------------------------------+
| 2. Static Core Question (from P2)                 |
|    Serve the existing static question first        |
|    to establish baseline in that domain            |
+---------------------------------------------------+
| 3. Personalized Follow-Up Generation              |
|    LLM generates 1 contextual follow-up using     |
|    identity context + previous answer              |
|    e.g., "You listed Blade Runner -- what about   |
|    its visual language specifically grabbed you?"   |
+---------------------------------------------------+
| 4. Depth Probing (optional, user-initiated)       |
|    "Want to go deeper?" button generates           |
|    another personalized question that connects     |
|    across domains (e.g., music taste <-> visual)   |
+---------------------------------------------------+
| 5. Summary & Synthesis                            |
|    After core + follow-ups complete, LLM           |
|    generates section summary + cross-domain        |
|    pattern detection                               |
+---------------------------------------------------+
```

**Prompt template for personalized question generation:**

```
You are a thoughtful interviewer building an aesthetic taste profile.
You already know the following about this person:

## Identity Context
{identityContext -- excerpts from BOOKS.md, AUDIO.md, enrichment answers, traits}

## Previous Responses in This Section
{existingResponses -- Q&A pairs from taste-profile.json for this section}

## Section: {sectionLabel}

Generate ONE follow-up question that:
1. References something specific from their identity context or previous answers
2. Probes WHY they prefer what they do, not just WHAT
3. Feels conversational -- like a friend who knows them asking a natural question
4. Explores an angle their previous answers haven't covered yet
5. Is concise (1-2 sentences max)

Do NOT:
- Ask generic questions that ignore the context
- Repeat topics already covered in previous responses
- Use survey language ("On a scale of 1-10...")
- Ask multiple questions at once
```

**Example personalized exchanges:**

> **Static (P2):** "Name 3-5 films you consider near-perfect."
> **User:** "Blade Runner, Stalker, Lost in Translation, Drive, Arrival"
>
> **Personalized (P2.5):** "Your BOOKS.md lists several sci-fi titles with themes of isolation and altered perception. Four of your five film picks share that same atmosphere. Is solitude a feature of stories you're drawn to, or is it more about the specific visual treatment of lonely spaces?"

> **Static (P2):** "What artists or albums have had a lasting impact?"
> **User:** "Radiohead, Boards of Canada, Massive Attack"
>
> **Personalized (P2.5):** "All three of those artists layer heavy texture over minimalist structures. Your CREATIVE.md mentions an appreciation for 'controlled complexity.' Does this principle -- density within restraint -- apply to how you think about visual design too?"

#### Data Model -- Where Taste Lives

Taste data lives in **two files** with distinct roles:

**1. Raw questionnaire responses: `data/digital-twin/taste-profile.json`** (existing, extended)

```json
{
  "version": "2.0.0",
  "createdAt": "...",
  "updatedAt": "...",
  "sections": {
    "movies": {
      "status": "completed",
      "responses": [
        {
          "questionId": "movies-core-1",
          "answer": "Blade Runner, Stalker, Lost in Translation...",
          "answeredAt": "...",
          "source": "static"
        },
        {
          "questionId": "movies-p25-1",
          "answer": "It's not solitude per se, it's the visual...",
          "answeredAt": "...",
          "source": "personalized",
          "generatedQuestion": "Your BOOKS.md lists several sci-fi titles...",
          "identityContextUsed": ["BOOKS.md:sci-fi-themes", "taste:movies-core-1"]
        }
      ],
      "summary": "..."
    },
    "fashion": { "status": "pending", "responses": [], "summary": null },
    "digital": { "status": "pending", "responses": [], "summary": null }
  },
  "profileSummary": null,
  "lastSessionAt": null
}
```

Changes from v1:
- `source` field distinguishes static vs personalized questions
- `generatedQuestion` stores the LLM-generated question text (since personalized questions aren't in the static definition)
- `identityContextUsed` tracks which identity sources informed the question (for provenance)
- Two new sections: `fashion`, `digital`
- Version bumped to 2.0.0

**2. Synthesized aesthetic profile: `data/digital-twin/aesthetics.json`** (planned in P1, populated by P2.5)

```json
{
  "version": "1.0.0",
  "updatedAt": "...",
  "profile": {
    "visualStyle": ["brutalist minimalism", "high-contrast neon", "controlled complexity"],
    "narrativePreferences": ["isolation themes", "slow burn", "ambiguity over resolution"],
    "musicProfile": ["textural electronica", "atmospheric layering", "functional listening"],
    "spatialPreferences": ["raw materials", "dramatic light", "intimacy over grandeur"],
    "culinaryIdentity": ["umami-driven", "improvisational cooking", "experience over formality"],
    "fashionSensibility": ["monochrome", "natural fibers", "minimal branding"],
    "digitalAesthetic": ["dark mode", "high information density", "subtle animation"],
    "antiPatterns": ["visual clutter", "forced symmetry", "saccharine sentimentality"],
    "corePrinciples": ["density within restraint", "function informing form", "earned complexity"]
  },
  "sources": {
    "tasteQuestionnaire": {
      "sectionsCompleted": 7,
      "totalResponses": 28,
      "lastUpdated": "..."
    },
    "enrichment": {
      "aesthetics": { "questionsAnswered": 5 },
      "favoriteBooks": { "analyzed": true, "themes": ["existential sci-fi", "systems thinking"] },
      "favoriteMovies": { "analyzed": true, "themes": ["atmospheric isolation", "neon noir"] },
      "musicTaste": { "analyzed": true, "themes": ["textural electronica", "ambient"] }
    },
    "documents": ["BOOKS.md", "AUDIO.md", "CREATIVE.md", "PREFERENCES.md"]
  },
  "crossDomainPatterns": [
    "Preference for 'controlled complexity' appears across music (layered textures), visual art (minimalist structure with dense detail), architecture (raw materials with precise placement), and food (complex umami built from simple ingredients)",
    "Anti-preference for overt sentimentality spans film (avoids melodrama), music (dislikes saccharine pop), and design (rejects decorative ornamentation)"
  ],
  "genomicCorrelations": {
    "tasteReceptorGenes": "TAS2R38 status may correlate with bitter-food tolerance preferences",
    "sensoryProcessing": "Olfactory receptor variants may explain heightened texture sensitivity"
  }
}
```

This file is the **canonical aesthetic profile** referenced by the Identity orchestrator (`identity.json`). It is regenerated whenever taste-profile.json accumulates significant new responses.

#### Implementation Steps

1. **Add 2 new sections** to `TASTE_SECTIONS` in `taste-questionnaire.js`: `fashion` and `digital`, each with 3 core questions and keyword-triggered follow-ups
2. **Add `aggregateIdentityContext(sectionId)`** to `taste-questionnaire.js` -- reads BOOKS.md, AUDIO.md, CREATIVE.md, PREFERENCES.md, enrichment answers, and existing taste responses to build a context string for the LLM
3. **Add `generatePersonalizedTasteQuestion(sectionId, existingResponses, identityContext)`** -- calls the active AI provider with the prompt template above, returns a single personalized follow-up question
4. **Add `POST /api/digital-twin/taste/:section/personalized-question`** route that returns a generated question
5. **Extend `submitAnswer()`** to accept `source: 'personalized'` and store `generatedQuestion` + `identityContextUsed` metadata
6. **Add "Go deeper" button** to TasteTab.jsx after each static follow-up cycle completes -- clicking it calls the personalized question endpoint
7. **Add `generateAestheticsProfile()`** to `taste-questionnaire.js` -- synthesizes all taste-profile.json responses + enrichment data into `aesthetics.json`
8. **Bump taste-profile.json version** to 2.0.0, migrate existing responses to include `source: 'static'`
9. **Update TasteTab.jsx** to render personalized questions differently (subtle indicator showing the twin referenced specific context)

#### Prerequisite Relaxation

The original spec listed P1 (Identity orchestrator) as a hard prerequisite. This is relaxed: P2.5 can read identity documents directly from the filesystem (`BOOKS.md`, `AUDIO.md`, etc.) and enrichment data from `meta.json` without needing the orchestrator layer. The orchestrator becomes useful for caching and cross-section queries but is not strictly required for context aggregation.

### P3: Mortality-Aware Goal Tracking
- Create `data/digital-twin/goals.json`
- Add `GET/POST/PUT/DELETE /api/digital-twin/identity/goals` routes
- Birth date input + SSA actuarial table lookup
- Genome-adjusted life expectancy: weight longevity markers (5 markers: FOXO3A, IGF1R, CETP, IPMK, TP53) and cardiovascular risk markers (5 markers: Factor V, 9p21, Lp(a), LPA aspirin, PCSK9) into adjustment factor
- Time-horizon calculation: years remaining, healthy years, percent complete
- Urgency scoring: `urgency = (goalHorizonYears - yearsRemaining) / goalHorizonYears` normalized
- Goal CRUD with category tagging and milestone tracking

### P4: Identity Tab UI
- Add `identity` tab to `TABS` constant in `constants.js`
- Create `IdentityTab.jsx` with dashboard layout (4 summary cards + cross-insights)
- Create `ChronotypeEditor.jsx` -- schedule visualization and override controls
- Create `TasteQuestionnaire.jsx` -- section-by-section prompted flow
- Create `GoalTracker.jsx` -- goal list with urgency heatmap and timeline view
- Wire sub-routes for deep dives

### P5: Cross-Insights Engine
- Add `generateCrossInsights(identity)` in identity service
- Cross-reference genome markers with chronotype, goals, and enrichment data
- Generate natural-language insight strings (e.g., caffeine + chronotype, longevity + goal urgency)
- Display on Identity dashboard and inject into CoS context when relevant
- Consider autonomous job: periodic identity insight refresh
- Example cross-insights from current marker data:
  - CLOCK + CRY1 + PER2 -> composite chronotype confidence (3 markers agreeing = high confidence evening/morning)
  - MTNR1B concern + evening chronotype -> "avoid eating after 8pm -- your melatonin receptor variant impairs late glucose handling"
  - CYP1A2 slow metabolizer + CLOCK evening -> "caffeine cutoff by noon, not 2pm"
  - FOXO3A/CETP/IGF1R longevity markers + cardiovascular risk -> adjusted life expectancy for goal urgency

## Extension Roadmap

This roadmap connects brain ideas and the Genome Section Integration project (0e6a0332) into a unified implementation sequence.

### Source Ideas
- **Brain idea 608dc733**: "Prompting Aesthetic Taste Docs via Digital Twin" -- use the twin's existing knowledge to generate personalized aesthetic preference questions
- **Brain idea 284dd487**: "Genome Types & Chronotype Trait" -- derive chronotype from 5 sleep/circadian markers + behavioral data
- **Project 0e6a0332**: "Genome Section Integration" -- unify genome data with Identity page architecture

### Phase Dependency Graph

```
P1: Identity Orchestrator & Chronotype ---- (brain idea 284dd487)
 |   Creates identity.json, chronotype.json,
 |   identity service, derivation from 5 sleep markers
 |
 +-> P2.5: Personalized Taste Prompting --- (brain idea 608dc733)
 |    Uses identity context to generate smart taste questions
 |    Enhances existing TasteTab with twin-aware follow-ups
 |
 +-> P3: Mortality-Aware Goal Tracking
 |    Birth date + genome longevity/cardio markers -> life expectancy
 |    Urgency scoring for prioritized goal management
 |
 +-> P4: Identity Tab UI
      Dashboard with summary cards for all 4 sections
      Sub-routes for chronotype, taste, goals deep dives
      |
      +-> P5: Cross-Insights Engine
           Reads all sections, generates natural-language insights
           Injects identity context into CoS agent briefings
```

### Implementation Priority
1. **P1** -- Foundation: nothing else works without the orchestrator
2. **P2.5** -- Quick win: enhances existing Taste tab with minimal new infrastructure
3. **P3** -- New feature: mortality-aware goals need genome data flowing through identity service
4. **P4** -- UI: renders what P1-P3 produce
5. **P5** -- Polish: cross-entity reasoning requires all sections populated

## Data Flow

```
User uploads 23andMe -> genome.json (117 markers, 32 categories)
                        |
Identity service reads 5 sleep markers + 2 caffeine markers
                        |
Derives chronotype.json (+ behavioral input from daily_routines enrichment)
                        |
Twin reads identity context -> generates personalized taste questions (P2.5)
                        |
User completes taste questionnaire -> taste-profile.json -> aesthetics.json
                        |
LLM analyzes books/movies/music docs -> seeds aesthetic profile themes
                        |
User sets birth date -> goals.json (life expectancy from actuarial + 10 genome markers)
                        |
Cross-insights engine reads all 4 sections -> generates natural-language insights
                        |
Identity tab renders unified dashboard with summary cards + insights
                        |
CoS injects identity context into agent briefings when relevant
```

## Files to Create/Modify

**New files:**
- `data/digital-twin/identity.json` -- orchestrator metadata
- `data/digital-twin/chronotype.json` -- derived chronotype profile
- `data/digital-twin/aesthetics.json` -- taste profile
- `data/digital-twin/goals.json` -- mortality-aware goals
- `server/services/identity.js` -- identity orchestration service
- `server/routes/identity.js` -- API routes
- `server/lib/identityValidation.js` -- Zod schemas
- `client/src/components/digital-twin/tabs/IdentityTab.jsx` -- dashboard
- `client/src/components/digital-twin/identity/ChronotypeEditor.jsx`
- `client/src/components/digital-twin/identity/TasteQuestionnaire.jsx`
- `client/src/components/digital-twin/identity/GoalTracker.jsx`
- `client/src/components/digital-twin/identity/CrossInsights.jsx`

**Modified files:**
- `client/src/components/digital-twin/constants.js` -- add Identity tab
- `client/src/pages/DigitalTwin.jsx` -- add Identity tab rendering
- `client/src/services/api.js` -- add identity API methods
- `server/index.js` -- mount identity routes
- `server/services/taste-questionnaire.js` -- add `generatePersonalizedTasteQuestion()` using identity context (P2.5)
- `client/src/components/digital-twin/tabs/TasteTab.jsx` -- wire personalized question generation (P2.5)

## Design Decisions

1. **Separate data files per section** (not one giant file) -- each section has independent update cadence and the genome file (82KB) is already large
2. **Derivation over duplication** -- chronotype reads from genome.json at query time rather than copying marker data. Identity service is the join layer
3. **Progressive disclosure** -- Identity tab shows summary cards; deep dives are sub-routes, not modals (per CLAUDE.md: all views must be deep-linkable)
4. **LLM-assisted but user-confirmed** -- aesthetic themes extracted by LLM from media lists are suggestions, not gospel. User confirms/edits
5. **No new dependencies** -- uses existing Zod, Express, React, Lucide stack
6. **Genome data stays read-only** -- identity service reads genome markers but never writes to genome.json
7. **Taste data consolidation** -- P2 created `taste-profile.json` (5 sections). P2.5 adds twin-aware personalized questions. Long-term, taste data migrates into `aesthetics.json` as the canonical aesthetic profile, with taste-profile.json as the raw questionnaire responses
8. **Weighted chronotype confidence** -- 5 sleep markers weighted by specificity: CRY1 (strongest DSPD signal) > CLOCK (evening tendency) > PER2 (circadian period) > MTNR1B (melatonin coupling) > DEC2 (duration, not phase). Behavioral data from daily_routines enrichment gets equal weight to genetic composite
