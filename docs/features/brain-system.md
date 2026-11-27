# Brain

Open **Brain → Inbox** or use the dashboard's **Quick Capture** widget. Captured text can be classified into People, Projects, Ideas and Admin. Brain stores the capture even when classification is disabled or needs review.

## Classification and review

Choose an enabled provider and model under **Brain → Config**. A recognized destination at or above the confidence threshold (initially 0.6) can be filed automatically. **Needs Review** holds uncertain or unclassified captures. Use **Trust** to inspect classification results. The Brain autonomy setting can turn automatic classification off, or use dry run to suggest a destination without filing. The daily budget limits automatic actions. Manual retry stays available.

Under **Digest**, generate a daily summary or a weekly review of open loops. Scheduled digests and reviews are opt-in and require a configured provider that can run without host tools. These jobs use their selected provider without broadening its authority through fallback.

## Capture a YouTube video

Paste a single video URL into **Quick Capture**. Open the advanced controls to choose artifacts, tags and a prompt for follow-up. Review captures in **Brain → YouTube**. Downloads and provider calls happen through user actions or configured jobs.

## Exchange IdeaLoom lists with Obsidian

Open **Brain → Ideas**. IdeaLoom lists are separate from Brain ideas. Enable the integration and select an existing Obsidian vault to use **Import** and **Export**. Import scans only the vault's `Idea Loom/` folder. Review the per-note result for skipped, conflicted, missing, malformed and unavailable notes.

If a vault note and local list both changed since their last exchange, neither is overwritten. Merge the changes by hand and rerun the exchange. An externally deleted note is reported as missing and its local list stays available. Use **Recreate deleted notes** to restore it. Deleting a local list leaves its vault note alone. An undownloaded iCloud file is unavailable and must be downloaded before exchange.

**Export automatically after an edit** is a separate opt-in. It updates only an existing note without a conflict. Turning off either sync setting cancels pending automatic writes. The lists and vault identifiers remain local.

See [Privacy Center](./privacy-center.md) for data controls and [API Explorer](../API.md) for integration endpoints.
