#!/bin/bash
# Blocks until a round dossier newer than the .last-coached marker appears,
# then prints its path and exits — the coaching session runs this in the
# background and gets woken exactly when there is something to debrief.
cd "$(dirname "$0")"
[ -f .last-coached ] || touch -t 202001010000 .last-coached
while true; do
  new=$(find rounds -name dossier.json -newer .last-coached 2>/dev/null | sort | head -1)
  if [ -n "$new" ]; then
    echo "$new"
    exit 0
  fi
  sleep 2
done
