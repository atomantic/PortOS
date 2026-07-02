# POST (Power On Self Test)

## Overview

POST is a daily cognitive self-test and training system within MeatSpace. It covers five cognitive domains: **Math**, **Memory**, **Wordplay**, **Verbal Agility**, and **Imagination**. Sessions are designed to take ~5 minutes and balance testing with active training — teaching techniques and building skills, not just measuring them.

## Cognitive Domains

### 1. Mental Math (existing)
- **Doubling Chain** — sequential doubling from a seed number
- **Serial Subtraction** — countdown by a fixed subtrahend (e.g., 100 - 7 - 7 - 7...)
- **Multiplication** — random N-digit multiplication problems
- **Powers** — base^exponent calculations
- **Estimation** — approximate large arithmetic within tolerance

### 2. Memory (new: Memory Builder)
Configurable memory training for songs, poems, sequences, speeches, or any ordered content.

**Built-in Content:**
- Tom Lehrer's "The Elements" — periodic table set to music, with interactive element identification

**Custom Content:**
- User adds any text/song/sequence they want to memorize
- System breaks it into chunks and builds progressive recall exercises

**Training Modes:**
- **Learn** — progressive reveal: show content line-by-line, then chunk-by-chunk, building from small to large
- **Fill-in-the-Blank** — show partial content with blanks to fill; difficulty increases as more words are blanked
- **Sequence Recall** — given a starting point, continue the sequence from memory
- **Random Prompt** — given a random line/chunk, identify what comes before and after
- **Speed Run** — recite the full sequence as fast as possible with accuracy tracking

**Spaced Repetition:**
- Track per-chunk mastery (how often recalled correctly, average response time)
- Focus training on weakest chunks
- Graduated difficulty: new items start with heavy hints, mastered items tested with no hints

### 3. Wordplay (existing, enhanced)
- **Pun/Wordplay** — create puns on given topics (LLM-scored)
- **Word Association** — free-associate with prompt words (LLM-scored)

### 4. Verbal Agility (existing)
- **Wit Comeback** — respond to scenarios with humor (LLM-scored)
- **Verbal Fluency** — name items in a category within time limit (LLM-scored)
- **Story Recall** — read a paragraph, answer detail questions (LLM-scored)

### 5. Imagination & Ideation (new)
Creative thinking exercises scored by AI for originality, elaboration, and feasibility.

- **What If** — respond to absurd hypothetical scenarios ("What if gravity reversed for 10 minutes every Tuesday?")
- **Alternative Uses** — list creative uses for a common object (divergent thinking classic)
- **Story Prompt** — given 3 random words, create a micro-story connecting them
- **Invention Pitch** — given a problem, pitch an inventive solution in 2-3 sentences
- **Reframe** — take a negative situation and reframe it positively/humorously

## Session Structure (~5 minutes)

A POST session pulls one drill from each enabled domain, time-budgeted:

| Domain | Drill Count | Time Budget |
|--------|-------------|-------------|
| Math | 1 drill (e.g., 10 multiplication problems) | ~60s |
| Memory | 1 memory item exercise | ~90s |
| Wordplay | 1 drill (e.g., 3 pun challenges) | ~60s |
| Verbal | 1 drill (e.g., 1 story recall) | ~60s |
| Imagination | 1 drill (e.g., 2 what-if prompts) | ~60s |

Total: ~5.5 minutes with transitions. Users can enable/disable any domain.

## Training vs Testing

Each domain supports two modes:
- **Train** — learning-focused: hints, progressive difficulty, immediate feedback, no final score
- **Test** — performance-focused: timed, scored, saved to session history

The session launcher lets users pick mode per-domain. Training sessions are tracked separately (practice count, streaks) but don't contribute to the scored POST history.

## Elements Song Memory Builder

### Content Structure
The Tom Lehrer "Elements Song" is stored as structured data:
- Full lyrics split into lines
- Each element name mapped to its atomic number and symbol
- Musical phrases grouped for chunked learning

### Interactive Features
- **Karaoke Mode** — lyrics scroll with timing, user fills in blanked element names
- **Element Flash** — show atomic number or symbol, user names the element (and vice versa)
- **Sequence Game** — "What element comes after Arsenic in the song?"
- **Progress Map** — periodic table colored by mastery (green = solid, yellow = shaky, red = unlearned)
- **Audio Reference** — link to the song for listening practice (user provides their own audio file)

### Data Model
```json
{
  "memoryItems": [
    {
      "id": "elements-song",
      "title": "The Elements (Tom Lehrer)",
      "type": "song",
      "builtin": true,
      "content": {
        "lines": [
          { "text": "There's antimony, arsenic, aluminum, selenium", "elements": ["Sb", "As", "Al", "Se"] },
          { "text": "And hydrogen and oxygen and nitrogen and rhenium", "elements": ["H", "O", "N", "Re"] }
        ],
        "chunks": [
          { "id": "verse-1", "lineRange": [0, 3], "label": "Verse 1" }
        ]
      },
      "mastery": {
        "overallPct": 45,
        "chunks": { "verse-1": { "correct": 12, "attempts": 20, "lastPracticed": "2026-03-08" } },
        "elements": { "Sb": { "correct": 5, "attempts": 5 }, "As": { "correct": 3, "attempts": 5 } }
      }
    }
  ]
}
```

### Custom Memory Items
Users can add their own items via the Config page:
```json
{
  "id": "user-uuid",
  "title": "Gettysburg Address",
  "type": "speech",
  "builtin": false,
  "content": {
    "lines": [
      { "text": "Four score and seven years ago our fathers brought forth on this continent, a new nation" },
      { "text": "conceived in Liberty, and dedicated to the proposition that all men are created equal." }
    ],
    "chunks": [
      { "id": "opening", "lineRange": [0, 1], "label": "Opening" }
    ]
  },
  "mastery": {}
}
```

## Scoring

- **Math**: accuracy (80%) + speed bonus (20%), server-rescored
- **Memory**: chunk accuracy (70%) + sequence accuracy (20%) + speed (10%)
- **Wordplay/Verbal/Imagination**: LLM-scored on quality criteria (80%) + speed bonus (20%)
- **Session score**: weighted average across all completed drills

## Data Files

- `data/meatspace/post-config.json` — drill settings, enabled modules, time limits
- `data/meatspace/post-sessions.json` — scored test session history
- `data/meatspace/post-memory-items.json` — memory builder content and mastery tracking
- `data/meatspace/post-training-log.json` — practice session log (unscored training)

## Routes

### Existing
- `GET/PUT /api/meatspace/post/config` — drill configuration
- `GET/POST /api/meatspace/post/sessions` — session CRUD
- `GET /api/meatspace/post/sessions/:id` — single session
- `GET /api/meatspace/post/stats` — rolling averages
- `POST /api/meatspace/post/drill` — generate math or LLM drill
- `POST /api/meatspace/post/score-llm` — score LLM drill responses

### New (M55)
- `GET/POST/PUT/DELETE /api/meatspace/post/memory-items` — memory item CRUD
- `POST /api/meatspace/post/memory-items/:id/practice` — submit practice result, update mastery
- `GET /api/meatspace/post/memory-items/:id/mastery` — get mastery breakdown
- `POST /api/meatspace/post/drill` — extended to support the `imagination` drill type
- `POST /api/meatspace/post/memory-drill` — generate memory drills (separate endpoint)

## UI Components

### Existing
- `PostTab` — view router (launcher, running, results, history, config)
- `PostSessionLauncher` — start screen with drill summary
- `PostDrillRunner` — math drill UI with timer
- `PostLlmDrillRunner` — LLM drill UIs (word-association, story-recall, etc.)
- `PostSessionResults` — score breakdown and save
- `PostHistory` — date-range analytics with charts
- `PostDrillConfig` — per-drill settings

### New (M55)
- `MemoryBuilder` — main memory training interface
- `MemoryItemList` — browse/add/edit memory items
- `MemoryPractice` — interactive practice with mode selection
- `ElementsSong` — specialized Elements Song UI with periodic table visualization
- `MasteryMap` — visual mastery progress (periodic table for elements, progress bar for generic items)
- `ImaginationDrillRunner` — UI for imagination/ideation drills
