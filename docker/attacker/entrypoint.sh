#!/usr/bin/env bash
set -euo pipefail

# Generate per-slot CycloneDDS unicast peers config (multicast does not reliably traverse Docker bridges)
COMP_IP="${DRONE_COMPANION_IP:-10.13.1.3}"
SIM_IP="${DRONE_SIM_IP:-10.13.1.5}"

cat > /tmp/cyclonedds.xml <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<CycloneDDS xmlns="https://cdds.io/config">
  <Domain id="any">
    <General>
      <AllowMulticast>false</AllowMulticast>
    </General>
    <Discovery>
      <Peers>
        <Peer address="${COMP_IP}"/>
        <Peer address="${SIM_IP}"/>
      </Peers>
    </Discovery>
  </Domain>
</CycloneDDS>
EOF

exec ttyd -W -p 7681 -b / tmux new-session -A -s main bash -l
