# Per-slot override of simulator/mgmt/routes/gcs.py.
# QGroundControl already runs in the lab's virtual desktop and is streamed to the browser
# (noVNC), so "Open QGC" just points the user at it instead of the macOS-only launch path.
from flask import make_response, request
from . import bp
from .utils import get_container


@bp.route("/qgc", methods=["POST"])
def open_qgc():
    host = request.host  # e.g. sim-<id>.<base>:4000
    url = "http://" + host.replace("sim-", "gcs-", 1) + "/vnc.html?autoconnect=1&resize=scale&path=websockify"
    try:
        c = get_container("ground-control-station")
        if c.status != "running":
            return make_response(f"Ground control station is not running (status: {c.status})", 400)
    except Exception as e:
        return make_response(f"Unexpected error: {e}", 500)
    return make_response(f"QGroundControl is running in your lab. Open it here: {url}", 200)
