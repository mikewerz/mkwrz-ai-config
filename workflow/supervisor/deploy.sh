#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$script_dir"

pid_file="${DEPLOY_PID_FILE:-.pid}"
log_file="${DEPLOY_LOG_FILE:-supervisor.log}"
expected_command="dist/index.js"
new_pid=""

cleanup_failed_start() {
  if [[ -n "$new_pid" ]] && kill -0 "$new_pid" 2>/dev/null; then
    kill "$new_pid" 2>/dev/null || true
  fi
  rm -f "$pid_file"
}

stop_existing() {
  if [[ ! -f "$pid_file" ]]; then
    echo "No managed supervisor PID found."
    return
  fi

  local old_pid command
  old_pid="$(<"$pid_file")"
  if [[ ! "$old_pid" =~ ^[0-9]+$ ]]; then
    echo "Invalid PID file: $pid_file" >&2
    exit 1
  fi
  if ! kill -0 "$old_pid" 2>/dev/null; then
    echo "Removing stale supervisor PID $old_pid."
    rm -f "$pid_file"
    return
  fi

  command="$(ps -p "$old_pid" -o command=)"
  if [[ "$command" != *"$expected_command"* ]]; then
    echo "Refusing to stop PID $old_pid because it is not the managed supervisor: $command" >&2
    exit 1
  fi

  echo "Stopping supervisor PID $old_pid."
  kill "$old_pid"
  for _ in {1..20}; do
    kill -0 "$old_pid" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$old_pid" 2>/dev/null; then
    echo "Supervisor did not stop after 10 seconds; terminating it." >&2
    kill -KILL "$old_pid"
  fi
  rm -f "$pid_file"
}

if [[ ! -f .env ]]; then
  echo "Missing $script_dir/.env; deployment configuration must remain on the VM." >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js 22.12+ and npm are required." >&2
  exit 1
fi

echo "Installing locked dependencies and verifying the supervisor."
npm ci
npm run verify

stop_existing
trap cleanup_failed_start ERR

echo "Starting the production supervisor."
deployment_started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
nohup node dist/index.js >> "$log_file" 2>&1 &
new_pid=$!
printf '%s\n' "$new_pid" > "$pid_file"
sleep 1

for _ in {1..20}; do
  if kill -0 "$new_pid" 2>/dev/null && DEPLOYMENT_STARTED_AT="$deployment_started_at" node --input-type=module <<'NODE'
import { loadEnvFile } from "node:process";
loadEnvFile();
const tracker = process.env.TRACKER_URL ?? "http://127.0.0.1:4310";
const supervisorId = process.env.SUPERVISOR_ID ?? "coordinator-vm";
const deployedAt = Date.parse(process.env.DEPLOYMENT_STARTED_AT ?? "");
try {
  const response = await fetch(new URL("/api/supervisors", tracker));
  if (!response.ok) process.exit(1);
  const body = await response.json();
  const online = Array.isArray(body.supervisors) && body.supervisors.some(
    (item) => item?.supervisor_id === supervisorId && item?.status === "online"
      && Date.parse(item?.started_at ?? "") >= deployedAt,
  );
  process.exit(online ? 0 : 1);
} catch {
  process.exit(1);
}
NODE
  then
    trap - ERR
    echo "Supervisor deployed successfully as PID $new_pid and registered with the tracker."
    exit 0
  fi
  kill -0 "$new_pid" 2>/dev/null || break
  sleep 1
done

echo "Supervisor failed to remain online in the tracker registry. Recent log output:" >&2
tail -n 80 "$log_file" >&2 || true
cleanup_failed_start
exit 1
