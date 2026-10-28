# Artist press & submission profile

Festival, distributor and press-kit forms keep asking for the same things: a bio in a few lengths, the name to print in credits, an artist or director statement, an AI process statement, past releases and screenings, and links. Forms change every season, so PortOS does not script them. Instead the artist curates those answers once, and whichever agent fills a form (Claude Desktop, ChatGPT, a CoS agent) reads them from PortOS.

## Where it lives

**Create › Music › Artists** (`/music/artists/:id`). Below the persona fields, each artist has collapsible groups:

| Group | Fields |
|---|---|
| Credits & contact | Name for credits, pronouns, based in, contact email |
| Bios | One-line, short (about 50–100 words), full |
| Statements & history | Artist / director statement, AI process statement, releases, screenings & awards |
| Links | Website, Suno, Spotify, Apple Music, YouTube, X, Instagram, TikTok, Substack, Bandcamp, SoundCloud, other links |
| Notes for agents | Standing rules for whoever fills forms (for example "never claim a premiere") |

Each group shows how many fields are filled; long fields show words and characters so a bio can be trimmed to a form's limit by the artist rather than by an agent. **Copy profile** copies the saved profile as Markdown, for pasting into an agent chat or a form helper that cannot reach PortOS.

The field list, caps, labels and grouping come from one spec, `SUBMISSION_FIELD_SPECS` in `server/lib/artistLimits.js`, shared by the sanitizer, the route schema, the editor and the export.

## How agents read it

- **Local MCP** — with **Settings › API Access › Agent Tools (MCP)** enabled and semantic reads granted, the read-only tool `music_artist_profile` (`music.artist-profile`) returns every artist's profile, or one artist's with `{ "name": "…" }`. See [agent-context](./agent-context.md).
- **HTTP** — `GET /api/artists/:id/submission-profile` returns `{ artistId, name, updatedAt, profile, missing, markdown }`. Agents PortOS did not spawn call it with `node scripts/portos-api.js` ([AGENT_API_KEY.md](../AGENT_API_KEY.md)).

`profile` holds every field as text (empty when not filled). `missing` names the fields still empty; links count as one entry and the agent notes are optional. The Markdown header tells the agent to use the text as written and to leave an empty answer for the artist rather than invent credits, awards, premieres or rights. Nothing here drafts, rewrites or fills gaps with a model.

## Limits

- The profile is the artist's own statement. It does not certify eligibility, premiere status or rights; per-project festival details belong to the music video's festival packet ([#13949](https://github.com/atomantic/PortOS/issues/13949)).
- PortOS never contacts festivals, submits entries, accepts terms or pays fees. Logins, screener passwords and payment details do not belong in the profile.

## Storage and sync

The fields are part of the `artists` record (`db-primary`, full record in the `data` JSONB column), so they federate with the Artists sync category between the user's own machines. `PORTOS_SCHEMA_VERSIONS.artists` is 2 so a peer that predates the profile refuses the record instead of stripping the curated text and writing the loss back. Records saved before the profile existed read with every profile field empty; no migration is needed.
