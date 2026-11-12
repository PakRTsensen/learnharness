#!/bin/sh
# Drop root after making the data volume writable.
#
# Docker creates a fresh named volume at /data owned by root:root, and bind
# mounts inherit the host UID. The app runs as the unprivileged `node` user,
# so fix ownership once here and exec the server as that user. The final
# process is node (via gosu's exec), so SIGTERM from Docker reaches it.
set -eu

DATA_DIR="${LH_DATA_DIR:-/data}"

if [ "$(id -u)" = "0" ]; then
	mkdir -p "$DATA_DIR"
	chown -R node:node "$DATA_DIR"
	exec gosu node "$@"
fi

exec "$@"
