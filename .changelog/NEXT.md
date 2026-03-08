# Unreleased Changes

## Added
- MeatSpace Life Calendar tab — "4000 Weeks" mortality-aware time grid with weeks from birth to death, remaining Saturdays/Sundays/sleep/seasons stats, and customizable activity budgets (coffees, showers, workouts, etc.)
- Life Calendar tile on MeatSpace Overview linking to full calendar view

## Changed

## Fixed
- Update scripts (update.sh/update.ps1) now build UI assets before restarting PM2, ensuring production serves the latest client build
- App refresh-config now correctly derives uiPort, devUiPort, and apiPort from ecosystem process labels (fixes apps showing dev UI port as Launch)
- App refresh-config and detection now auto-detect buildCommand from package.json, enabling Build button for apps with production builds

## Removed
