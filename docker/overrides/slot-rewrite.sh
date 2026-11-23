#!/bin/sh
# Rewrites upstream's hardcoded 10.13.0.x lab addresses to this slot's subnet, then runs the real command.
# Needed because DVD bakes 10.13.0.x into app code (telemetry destinations, companion REST URL, DDS peers).
: "${SLOT_SUBNET:?SLOT_SUBNET (e.g. 10.13.2) required}"
for f in /interface/app.py /interface/routes/logs.py /interface/static/js/flightController.js \
         /etc/cyclonedds.xml /app/simulator/mgmt/routes/bridge.py /app/simulator/mgmt/routes/stages.py \
         /app/simulator/conf/cyclonedds.xml; do
  [ -f "$f" ] && sed -i "s/10\.13\.0\./${SLOT_SUBNET}./g" "$f"
done
# Simulator page's browser JS talks Socket.IO straight to http://localhost:3000. In the web range the
# browser reaches the companion via this lab's admin-<id> host, so derive it from the page origin.
# Also disable upstream's "not accessing from localhost origin" SweetAlert popup.
T=/app/simulator/mgmt/templates/pages/simulator.html
if [ -f "$T" ]; then
  sed -i 's#const CC_URL = "http://localhost:3000";#const CC_URL = location.protocol + "//" + location.host.replace(/^sim-/, "admin-");#' "$T"
  sed -i 's#transports: \["websocket","polling"\]#transports: ["websocket"]#' "$T"
  sed -i "s#window.location.hostname !== 'localhost'#false#g" "$T"
fi
exec "$@"
