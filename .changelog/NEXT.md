# Release vNEXT

Released: TBD

## Overview

In-tree `portos-ai-toolkit` and auto-migration of legacy codex provider configs.

## Changed

- **`portos-ai-toolkit` is now vendored in-tree at `server/lib/aiToolkit/`** instead of being pulled from npm. PortOS no longer ships an external `portos-ai-toolkit` dependency in `server/package.json` — `createAIToolkit`, `createProviderStatusService`, and the four toolkit Router factories now live next to the rest of the server code. The toolkit's `uuid` dep was dropped (swapped for built-in `crypto.randomUUID()`), so this removes two transitive packages from `node_modules/`. The scaffold-generated app templates (`server/routes/scaffoldPortOS.js`) still emit `portos-ai-toolkit` imports — those are independent apps that can keep consuming the published npm package; PortOS itself does not.

## Fixed

- **Legacy codex provider configs auto-migrate to the `codex-configured-default` sentinel on boot.** PortOS now treats Codex CLI as "no `--model` flag — let `~/.codex/config.toml` decide" via the sentinel, but existing `data/providers.json` files from before that change still pinned real model ids (`gpt-5`, `gpt-5-codex`, `gpt-5.2`) and would pass `--model gpt-5.2` to a Codex CLI that's since renamed those models. The provider loader (`server/lib/aiToolkit/providers.js`) now rewrites any codex entry's `models[]`, `defaultModel`, `lightModel`, `mediumModel`, and `heavyModel` to the sentinel on the first read after upgrade. Idempotent — already-migrated configs are untouched. Triggered explicitly at startup so the migration runs before the first inbound request consults the file.
