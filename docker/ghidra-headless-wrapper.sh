#!/bin/sh
# Ghidra's settings and caches must live in the solver's writable workspace.
set -eu
export JAVA_HOME=/opt/jdk
export JAVA_TOOL_OPTIONS="${JAVA_TOOL_OPTIONS:-} -Duser.home=/work"
export XDG_CONFIG_HOME=/work/.config XDG_CACHE_HOME=/work/.cache
exec /opt/ghidra/support/analyzeHeadless "$@"
