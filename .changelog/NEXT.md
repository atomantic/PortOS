## Added

- **Xcode Multi-Platform template** — new "Xcode Multi-Platform" app template scaffolds a SwiftUI project with iOS, macOS, and watchOS targets via XcodeGen
  - Generic `deploy.sh` with `--ios`, `--macos`, `--watch`, `--all` flags for TestFlight deployment
  - Generic `take_screenshots.sh` and `take_screenshots_macos.sh` for App Store screenshot automation
  - UI test target with `ScreenshotTests.swift` stubs for XCUITest-based screenshot capture
  - Shared module for cross-platform code, macOS entitlements, watchOS companion app
- **Xcode script health check** — PortOS now detects missing management scripts (deploy, screenshots) in Xcode-managed apps and surfaces a banner in the app detail overview with one-click install
- Deploy panel now includes `--watch` (watchOS) flag option
- **Obsidian Notes Manager** in Brain section — browse, search, edit, and create notes in Obsidian vaults synced via iCloud
  - Auto-detects Obsidian vaults from iCloud directory
  - Vault browser with folder tree, search, tags panel, and markdown preview with wikilink navigation
  - Inline note editor with Cmd+S save, backlinks panel, and frontmatter properties view
  - Full-text search with context snippets and relevance ranking
  - Link graph endpoint for vault-wide wikilink visualization

## Fixed

- **Memory dedup — duplicate approval requests** — memory extractor now checks existing active and pending memories (via vector similarity + text prefix matching) before proposing new ones, and the LLM classification prompt now includes existing memories so it avoids re-proposing semantically equivalent knowledge

- **Xcode `deploy.sh` template — altool upload check false-positive** — generated deploy scripts grepped altool output for plain `ERROR: ` to detect upload failures, but altool's multipart uploader logs every transient retry as `ERROR: [ContentDelivery.Uploader.X] WILL RETRY PART N. Checksums do not match.` On flaky/slow networks the script killed deploys mid-recovery. Switched to Apple's definitive failure markers only: `UPLOAD FAILED|Validation failed \(|ERROR ITMS-|product-errors`. Affects iOS, macOS, and watchOS upload sections in `xcodeScripts.js`.
- Submodule status API (`/api/git/submodules/status`) always returned empty array — `stdout.trim()` was stripping the leading space status character from `git submodule status` output, causing the regex parser to fail
- CoS agents page crash: pipe characters (`|`) in task descriptions triggered infinite loop in markdown parser — non-table pipes now treated as normal text with safety fallback
- CoS agents API returned full output arrays (600KB+) for all agents in listing — output now stripped from listing response and loaded on demand
