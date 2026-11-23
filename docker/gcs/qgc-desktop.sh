#!/usr/bin/env bash
export DISPLAY=:99 XDG_RUNTIME_DIR=/tmp/xdg-gcs QT_QUICK_BACKEND=software LIBGL_ALWAYS_SOFTWARE=1 QT_XCB_GL_INTEGRATION=none
mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
Xvfb :99 -screen 0 1440x900x24 -nolisten tcp &
sleep 2
openbox &
# VNC bound to loopback only; the lab proxy + websockify are the only way in.
x11vnc -display :99 -localhost -nopw -forever -shared -rfbport 5900 -quiet &
websockify --web /usr/share/novnc 6080 localhost:5900 &
# Keep QGC running (restart if the user closes it).
while true; do /home/gcs/QGroundControl.AppImage --appimage-extract-and-run; sleep 3; done
