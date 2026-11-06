#!/bin/sh
# APT has already checked Debian's signatures. Bind the signed metadata it
# accepted to this recipe's snapshot before installing any packages.
set -eu
lists=$1
pins=$2
cd "$lists"

# APT can also accept a detached Release/Release.gpg pair. Reject any extra
# signed source, including that fallback, in addition to checking every pin.
actual=0
for file in ./*_InRelease ./*_Release ./*_Release.gpg; do
  if [ -f "$file" ]; then actual=$((actual + 1)); fi
done
expected=$(wc -l < "$pins")
if [ "$actual" -ne "$expected" ]; then
  echo "Expected $expected signed Debian snapshot indexes; found $actual" >&2
  exit 1
fi
sha256sum -c "$pins"
