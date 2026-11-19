#!/bin/sh
set -eu
export JAVA_HOME=/opt/jdk
exec /opt/jadx/bin/jadx "$@"
