#!/bin/sh
# Run from the extracted bundle root. This creates one owner-only Host Backend
# manifest containing the final absolute asset root. It never replaces a file.
set -eu
set -C
umask 077
bundle=$(pwd -P)
case "$bundle" in
  *[[:cntrl:]]*) echo 'Unsupported control character in bundle path' >&2; exit 1 ;;
esac
if [ ! -x "$bundle/bin/holo" ] || [ ! -f "$bundle/private/v86-assets/agent.cpio" ]; then
  echo 'Run from the extracted Holonomy bundle root' >&2
  exit 1
fi
escaped=$(printf '%s' "$bundle/private/v86-assets" | /usr/bin/sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
printf '{"schemaVersion":1,"backends":{"experimental.v86-v1":{"implementation":"builtin.v86-v1","artifactRoot":"%s"}}}\n' "$escaped" > private/process-backends.json
