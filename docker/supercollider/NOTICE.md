# PortOS SuperCollider runtime — license and source notices

This image is built locally by `npm run setup:supercollider` from the recipe in
this directory. PortOS does not publish or redistribute a prebuilt image.

## SuperCollider

- Version: 3.14.1 (`sclang`, `scsynth`, the stock class library and the stock
  server plugins; no Qt GUI, IDE, supernova, Quarks or third-party plugins)
- License: GNU General Public License, version 3 or later. The full text is
  installed at `/usr/local/share/doc/supercollider/COPYING`, with `AUTHORS`.
- Corresponding source: the official release tarball
  `https://github.com/supercollider/supercollider/releases/download/Version-3.14.1/SuperCollider-3.14.1-Source.tar.bz2`
  (SHA-256 `ee640c68777ae697682066ce5c4a8b7e56c5b223e76c79c13b5be5387ee55bb2`),
  built unmodified with the CMake options listed in the `Dockerfile`. The same
  reference is written to `/usr/local/share/doc/supercollider/SOURCE`.
- Upstream: https://supercollider.github.io/

## Debian packages

The base image is the official `debian:trixie-20260918-slim` image (pinned by
digest), and every package is installed from `snapshot.debian.org` at
`20260918T000000Z`. Each package's copyright and license file remains at
`/usr/share/doc/<package>/copyright` inside the image; the exact runtime package
list is recorded in `/usr/local/share/doc/supercollider/runtime-packages.txt`.
Source for any of them is available from the same snapshot
(`https://snapshot.debian.org/`).

## PortOS files

`sclang_conf.yaml` and this notice are part of PortOS and carry the PortOS
repository license.
