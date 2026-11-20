#!/bin/sh
# Invoke the venv interpreter by its own path; an external Python symlink loses the venv.
exec /opt/angr/bin/python "$@"
