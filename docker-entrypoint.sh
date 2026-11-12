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
	# Multiuser Milestone 1 only needs its runtime directories to exist for the
	# fail-closed readiness check. They remain node-owned here: the Phase 3
	# root helper replaces this transitional ownership with account UIDs/GIDs.
	if [ "${LH_DEPLOYMENT_MODE:-}" = "multiuser-web" ]; then
		mkdir -p \
			"${LH_ACCOUNT_ROOT:-$DATA_DIR/accounts}" \
			"${LH_CONTROLLER_STATE_DIR:-$DATA_DIR/controller}" \
			"${LH_STAGING_DIR:-$DATA_DIR/staging}" \
			"${LH_SNAPSHOT_DIR:-$DATA_DIR/snapshots}" \
			"${LH_PRIVATE_WORK_DIR:-$DATA_DIR/work}"
	fi
	chown -R node:node "$DATA_DIR"
	exec gosu node "$@"
fi

exec "$@"
