# PortOS managed SuperCollider runtime (sclang + scsynth + stock class library
# and plugins), built only by `npm run setup:supercollider`. Contract, limits and
# platform evidence: docs/SUPERCOLLIDER.md. License/source notices: NOTICE.md.
#
# Every input is pinned so a rebuild on another install produces the same
# runtime:
#   - the Debian base image by digest,
#   - every Debian package through snapshot.debian.org at the base image's own
#     serial date (the official images are built from that snapshot),
#   - the SuperCollider release source tarball by SHA-256.
#
# Changing anything in this directory changes the recipe hash PortOS stamps on
# the image, which marks an older image stale and its readiness evidence void.
# Bump SUPERCOLLIDER_RUNTIME_VERSION in server/lib/superColliderRuntime.js with
# any pin change; its test fails when the two disagree.

ARG DEBIAN_IMAGE=debian:trixie-20260918-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a

FROM ${DEBIAN_IMAGE} AS base
ARG DEBIAN_SNAPSHOT=20260918T000000Z
# Point apt at the dated snapshot instead of the moving mirror. Valid-Until is
# necessarily in the past for an archived Release file.
RUN set -eux; \
    sed -i \
      -e "s#http://deb.debian.org/debian-security#http://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT}#" \
      -e "s#http://deb.debian.org/debian\$#http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}#" \
      /etc/apt/sources.list.d/debian.sources; \
    grep -q "snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}" /etc/apt/sources.list.d/debian.sources; \
    printf 'Acquire::Check-Valid-Until "false";\nAcquire::Retries "5";\nAPT::Install-Recommends "false";\n' \
      > /etc/apt/apt.conf.d/99portos-snapshot

FROM base AS build
ARG SC_VERSION=3.14.1
ARG SC_SOURCE_SHA256=ee640c68777ae697682066ce5c4a8b7e56c5b223e76c79c13b5be5387ee55bb2
RUN set -eux; \
    apt-get update; \
    apt-get install -y \
      build-essential bzip2 ca-certificates cmake curl pkg-config \
      libasound2-dev libfftw3-dev libjack-jackd2-dev libncurses-dev \
      libreadline-dev libsndfile1-dev libudev-dev; \
    rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    curl -fsSL --retry 5 -o /tmp/sc.tar.bz2 \
      "https://github.com/supercollider/supercollider/releases/download/Version-${SC_VERSION}/SuperCollider-${SC_VERSION}-Source.tar.bz2"; \
    echo "${SC_SOURCE_SHA256}  /tmp/sc.tar.bz2" | sha256sum -c -; \
    mkdir /src; \
    tar -xjf /tmp/sc.tar.bz2 -C /src --strip-components=1; \
    rm /tmp/sc.tar.bz2
# Headless build: no Qt/IDE/editor integrations, no X11/Avahi/HID/Link, no
# supernova. NATIVE stays off so the binaries run on any CPU of this architecture.
RUN set -eux; \
    cmake -S /src -B /build \
      -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr/local \
      -DSC_QT=OFF -DSC_IDE=OFF -DSC_EL=OFF -DSC_VIM=OFF \
      -DSUPERNOVA=OFF -DNO_X11=ON -DNO_AVAHI=ON -DSC_HIDAPI=OFF -DSC_ABLETON_LINK=OFF \
      -DENABLE_TESTSUITE=OFF -DINSTALL_HELP=OFF -DNATIVE=OFF -DUSE_CCACHE=OFF; \
    cmake --build /build --parallel "$(nproc)"; \
    cmake --install /build; \
    mkdir -p /usr/local/share/doc/supercollider; \
    cp /src/COPYING /src/AUTHORS /usr/local/share/doc/supercollider/; \
    echo "SuperCollider ${SC_VERSION} source: https://github.com/supercollider/supercollider/releases/tag/Version-${SC_VERSION} (sha256 ${SC_SOURCE_SHA256})" \
      > /usr/local/share/doc/supercollider/SOURCE
# The runtime stage installs exactly the Debian packages that own the shared
# libraries the installed binaries and plugins link against.
RUN set -eux; \
    find /usr/local/bin /usr/local/lib -type f \( -name 'sclang' -o -name 'scsynth' -o -name '*.so' \) -print0 \
      | xargs -0 ldd 2>/dev/null \
      | awk '$2 == "=>" && $3 ~ /^\// && $3 !~ /^\/usr\/local\// { print $3 }' | sort -u \
      | xargs realpath | xargs dpkg-query -S \
      | cut -d: -f1 | sort -u > /usr/local/share/doc/supercollider/runtime-packages.txt; \
    test -s /usr/local/share/doc/supercollider/runtime-packages.txt

FROM base AS runtime
COPY --from=build /usr/local /usr/local
RUN set -eux; \
    apt-get update; \
    xargs -a /usr/local/share/doc/supercollider/runtime-packages.txt apt-get install -y; \
    rm -rf /var/lib/apt/lists/*; \
    ldconfig; \
    if ldd /usr/local/bin/sclang /usr/local/bin/scsynth | grep 'not found'; then exit 1; fi; \
    sclang -v; \
    scsynth -v
COPY sclang_conf.yaml /opt/portos/sclang_conf.yaml
COPY NOTICE.md /usr/local/share/doc/supercollider/PORTOS-NOTICE.md
# Renders run as an unprivileged host-mapped user with a read-only root and a
# private tmpfs home; nothing here needs to be writable at runtime.
ENV LANG=C.UTF-8
WORKDIR /tmp
