#!/bin/bash
# Runs linux-poc.mjs inside a disposable Debian container as uid 1000 with three
# extra tmpfs volumes: one owned by the user (-> $topdir/.Trash-1000), one with a
# root-created sticky .Trash (-> $topdir/.Trash/1000), and one root-owned 755
# topdir where no trash directory can be created (-> bounded EACCES refusal).
# GLib's `gio trash` and trash-cli are installed as independent reference
# implementations. Usage: linux-docker-run.sh <this directory>
set -u
POC_DIR="$1"
docker run --rm \
  --tmpfs /mnt/vol:uid=1000,gid=1000,mode=755 \
  --tmpfs /mnt/vol2:uid=0,gid=0,mode=755 \
  --tmpfs /mnt/vol3:uid=0,gid=0,mode=755 \
  -v "$POC_DIR:/poc:ro" \
  node:22-bookworm bash -c '
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null 2>&1
apt-get install -y -qq libglib2.0-bin trash-cli >/dev/null 2>&1
mkdir -m 777 /mnt/vol2/pub /mnt/vol3/pub
mkdir -m 1777 /mnt/vol3/.Trash
cp -r /poc /home/node/poc && chown -R node:node /home/node/poc
su node -c "cd /home/node/poc && HOME=/home/node node linux-poc.mjs"
'
