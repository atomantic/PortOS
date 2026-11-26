---
name: portos-music-video-blender
description: Author a PortOS music video as a Blender film — Python scripts that build every shot, rendered per shot by PortOS and reviewed in the Music Video UI. Invoke when writing or revising a project's film scripts, syncing its shots, or driving its renders and cuts through the API.
---

# Authoring a Blender film in PortOS

1. Choose **Blender film** and analyze the song. Read
   `GET /api/music-video/:id/blender` using the PortOS API client. Resolve
   `tool.ready` through the saved execution configuration if needed.
   Trusted local scripts run with the operator's full host access. Work with
   reviewed local source.
2. Generate a starter with `POST .../blender/workspace`. Read `song.json` for
   timing and edit `src/film.py` and its local dependencies. Use the starter
   for `describe`, `build_shot` and `frame`. Place ordered shot boundaries
   on the frame grid and plan complete coverage, any pre-song lead-in and
   handles needed by transitions. Leave managed manifest and render files
   to PortOS. Use the [model library workflow](../../../docs/features/blender-models.md)
   to bring in a locally staged model.
3. **Sync shots from scripts** (`POST .../blender/sync`). Follow the background
   job and resolve reported problems. Replacing unrelated Board scenes
   requires an explicit replacement choice. Re-sync when shot inventory,
   option declarations or fps change.
4. Render stills for composition, then contact sheets and previews for timing.
   Compare a timing reference to a PortOS sheet on its matching grid when the
   director has attached one. Watch continuous preview against the master and
   review shot notes. The render endpoint accepts `quality: 'still'`,
   `'sheet'`, `'preview'` or `'final'`. Read stale reasons and job logs to
   identify what needs a new render.
5. Assemble a preview cut with `POST .../blender/cut` when a portable review
   draft is needed. Inspect the film and current creative-review basis.
   Verify lyrics or mark the song instrumental, then complete the art and
   storyboard review using the authenticated session and genuine evidence.
6. Render all current final shots, then use **Final render**
   (`POST /api/music-video/:id/render`) to join them with the song. Resolve
   gaps, stale shots and missing handles surfaced by readiness. Clear
   rendered frames only when requested. Prepared drafts and final files can
   remain local. The human handles public Suno and social publication.

- [Music Video Blender contract](../../../docs/features/music-video.md#blender-films)
- [Starter film](../../../server/services/film/py/starter/film.py) and
  [timing helpers](../../../server/services/film/py/portos_film/timing.py)
- [Film request schemas](../../../server/lib/musicVideo/musicVideoBlenderValidation.js),
  [Blender router](../../../server/routes/musicVideoBlender.js) and
  [driver](../../../server/services/film/py/portos_blender_driver.py)
