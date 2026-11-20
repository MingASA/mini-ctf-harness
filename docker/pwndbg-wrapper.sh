#!/bin/sh
# Keep the ordinary system GDB available and all debugger state writable/offline.
export HOME="${HOME:-/work}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"
export DEBUGINFOD_URLS=
exec /opt/pwndbg/bin/pwndbg "$@"
