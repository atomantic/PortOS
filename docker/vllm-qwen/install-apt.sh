#!/bin/bash
# The base supplies the archive keyring. Disabling all other sources prevents
# a surviving CUDA or Ubuntu mirror from filling gaps in the reviewed snapshot.
set -euo pipefail
cd /tmp/portos-vllm
snapshot=20260827T000000Z
for suite in noble noble-updates noble-security; do
  echo "deb [arch=amd64 signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg check-valid-until=no] https://snapshot.ubuntu.com/ubuntu/$snapshot/ $suite main universe"
done > sources.list
apt=(apt-get -o Dir::Etc::sourcelist=/tmp/portos-vllm/sources.list -o Dir::Etc::sourceparts=-)
rm -rf /var/lib/apt/lists/*
"${apt[@]}" -o APT::Update::Error-Mode=any update
prefix="/var/lib/apt/lists/snapshot.ubuntu.com_ubuntu_${snapshot}_dists"
sha256sum --check <<EOF
cdb2f31d809f589719a53c6ad15f255b27569c4059542ada282aaa21b8e164b0  ${prefix}_noble_InRelease
5daf2a57c1a889eefca4831b64edd32aeb3dbc206a7a23ed50dfb67629c004d9  ${prefix}_noble-updates_InRelease
2f6284fe2153022766d2306edb4125dbd32bb2328ce0df603b723852570bc926  ${prefix}_noble-security_InRelease
EOF
"${apt[@]}" install -y --no-install-recommends python3.12 python3.12-venv python3.12-dev build-essential patch curl ca-certificates
while read -r _ package; do
  curl --fail --show-error --silent --location --output "$package" "https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2404/x86_64/$package"
done < cuda-packages.sha256
sha256sum --check --strict cuda-packages.sha256
"${apt[@]}" install -y --no-install-recommends ./*.deb
rm -rf /var/lib/apt/lists/* ./*.deb
