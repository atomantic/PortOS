# Unreleased Changes

## Added
- Messages Full Sync now reconciles cache against inbox, pruning messages that were archived/deleted/replied outside PortOS
- MeatSpace Life Calendar tab — "4000 Weeks" mortality-aware time grid with weeks from birth to death, remaining Saturdays/Sundays/sleep/seasons stats, and customizable activity budgets (coffees, showers, workouts, etc.)
- Life Calendar tile on MeatSpace Overview linking to full calendar view

## Changed
- Merged Eyes tab into Body tab — eye prescriptions now appear below body composition chart
- POST promoted to top-level page outside MeatSpace
- Life Calendar redesigned as admin dashboard: summary bar + side-by-side grid/stats layout on desktop, compact time-remaining sidebar, inline activity budget card
- Years view uses fluid CSS grid cells that fill available card width
- Months view shows decade-per-row with flex-wrap (no horizontal scrolling)

## Fixed
- Life Calendar: birthdays and holidays now visible on Week view (fixed time-of-day offset bug and cross-birthday-boundary event mapping)
- Life Calendar: holidays now shown on Month view with event type coloring
- Life Calendar: Year view no longer applies birthday/holiday coloring since every cell contains both
- Update scripts (update.sh/update.ps1) now build UI assets before restarting PM2, ensuring production serves the latest client build
- App refresh-config now correctly derives uiPort, devUiPort, and apiPort from ecosystem process labels (fixes apps showing dev UI port as Launch)
- App refresh-config and detection now auto-detect buildCommand from package.json, enabling Build button for apps with production builds

## Removed
- Eyes tab removed from MeatSpace (consolidated into Body tab)
- POST tab removed from MeatSpace (now a standalone top-level page)
