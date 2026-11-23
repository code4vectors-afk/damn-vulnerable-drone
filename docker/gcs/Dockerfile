# Upstream GCS (QGroundControl AppImage) + virtual desktop streamed to the browser via noVNC.
FROM n1ckaleks/damn-vulnerable-drone-ground-control-station-lite:latest
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      x11vnc novnc websockify openbox xvfb dbus-x11 \
    && rm -rf /var/lib/apt/lists/*
COPY qgc-desktop.sh /usr/local/bin/qgc-desktop.sh
COPY vnc-entry.sh /vnc-entry.sh
RUN chmod +x /usr/local/bin/qgc-desktop.sh /vnc-entry.sh
EXPOSE 6080
ENTRYPOINT ["/vnc-entry.sh"]
