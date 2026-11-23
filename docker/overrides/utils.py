# Per-slot override of simulator/mgmt/routes/utils.py (bind-mounted by the slot compose).
# Adds SLOT_PREFIX so multiple labs can coexist with unique container names.
import os
import docker

LITE = str(os.getenv("LITE", "")).lower() in ("1", "true", "yes", "on")
SLOT_PREFIX = os.getenv("SLOT_PREFIX", "")


def get_container(name: str):
    full_name = f"{SLOT_PREFIX}{name}-lite" if LITE else f"{SLOT_PREFIX}{name}"
    client = docker.from_env()
    return client.containers.get(full_name)
