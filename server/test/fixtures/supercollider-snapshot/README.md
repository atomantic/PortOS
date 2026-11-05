# Debian snapshot fixtures

The three current `InRelease` files were downloaded over HTTPS from Debian
Snapshot at `20261104T212339Z`. `trixie` and `trixie-updates` came from the
`debian` archive; `trixie-security` came from `debian-security`. Their SHA-256
values are in `docker/supercollider/debian-inrelease.sha256`.

`older-trixie-updates.InRelease` came from the `debian` archive at
`20261001T000000Z`; its signed date is 2026-09-30 and its uncompressed SHA-256
is `b993f7ba21582a4311a5e5ee0f8b3d4485aa20e4fff273efbe76ed79429cbd62`.
It proves a real, older signed index is rejected as a replay.

All four files were checked against Debian's published archive
keys. The Debian 13 archive key fingerprint is
`04B54C3CDCA79751B16BC6B5225629DF75B188BD`; the security archive key is
`5E04A1E3223A19A20706E20F9904613D4CCE68C6`. The `trixie` file also verifies
with the Debian 13 release key `41587F7DB8C774BCCF131416762F67A0B2C39DE4`.
Key information: https://ftp-master.debian.org/keys.html.

When refreshing the pins, replace the three current fixtures with the same
authenticated, signature-verified bytes.
Keep the older fixture for the replay test unless it becomes the pinned file.
