#!/bin/sh
# Debian Sage uses Debian's Python and its packaged mathematical libraries.
export PATH=/usr/bin:/bin:$PATH
export DOT_SAGE="${DOT_SAGE:-/work/.sage}"
exec /usr/bin/sage "$@"
