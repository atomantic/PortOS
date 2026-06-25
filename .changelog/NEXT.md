# Unreleased

## Editorial checks

- **[issue-1667] Final-part editorial verdicts no longer lose their carried setup context on a packed last chunk.** The cross-chunk "setup so far" digest normally yields to manuscript coverage — but two whole-story checks (`arc.climax-agency`, `emotion.reaction-proportionality`) gate their verdict to the final part and anchor it on a snippet carried in that digest (the climax candidate / the unprocessed event). When the final chunk packed to within a few hundred chars of the provider window, the digest was silently dropped and the final-only finding was missed. These checks now opt into a `reserveSetupDigest` guarantee that trims the final chunk's manuscript tail to make room for the digest (the inverse of the usual yield), scoped to the final chunk and opt-in checks only — every other chunk and every non-reserving check keeps full manuscript coverage. (`server/lib/editorial/checkRegistry.js`)
