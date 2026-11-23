#!/usr/bin/env bash
# Start the browser-streamed QGC desktop in the background, then run the upstream entrypoint.
su gcs -c "nohup /usr/local/bin/qgc-desktop.sh > /tmp/qgc-desktop.log 2>&1 &"
exec /entrypoint.sh "$@"
