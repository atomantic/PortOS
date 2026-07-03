# Unreleased

## Fixed

- **PM2 standardization no longer overwrites a PM2 config PortOS didn't generate.** Standardizing an app used to always regenerate `ecosystem.config.cjs`, silently replacing a hand-written one — losing its custom ports and settings. A config PortOS didn't generate is now preserved by default (and its ports are left untouched in `.env`/Vite too); PortOS only regenerates its own previously-generated config. To deliberately replace a custom config, opt in with the overwrite flag when standardizing.
