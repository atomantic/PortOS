## Fixed

- Submodule status API (`/api/git/submodules/status`) always returned empty array — `stdout.trim()` was stripping the leading space status character from `git submodule status` output, causing the regex parser to fail
