#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$script_dir"

pid_file="${DEPLOY_PID_FILE:-.pid}"
log_file="${DEPLOY_LOG_FILE:-app.log}"
bootstrap_log="${DEPLOY_BOOTSTRAP_LOG_FILE:-app.bootstrap.log}"
expected_command="dist/server/index.js"
new_pid=""

cleanup_failed_start() {
  if [[ -n "$new_pid" ]] && kill -0 "$new_pid" 2>/dev/null; then
    kill "$new_pid" 2>/dev/null || true
  fi
  rm -f "$pid_file"
}

stop_existing() {
  if [[ ! -f "$pid_file" ]]; then
    echo "No managed tracker PID found."
    return
  fi

  local old_pid command
  old_pid="$(<"$pid_file")"
  if [[ ! "$old_pid" =~ ^[0-9]+$ ]]; then
    echo "Invalid PID file: $pid_file" >&2
    exit 1
  fi
  if ! kill -0 "$old_pid" 2>/dev/null; then
    echo "Removing stale tracker PID $old_pid."
    rm -f "$pid_file"
    return
  fi

  command="$(ps -p "$old_pid" -o command=)"
  if [[ "$command" != *"$expected_command"* ]]; then
    echo "Refusing to stop PID $old_pid because it is not the managed tracker: $command" >&2
    exit 1
  fi

  echo "Stopping tracker PID $old_pid."
  kill "$old_pid"
  for _ in {1..20}; do
    kill -0 "$old_pid" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$old_pid" 2>/dev/null; then
    echo "Tracker did not stop after 10 seconds; terminating it." >&2
    kill -KILL "$old_pid"
  fi
  rm -f "$pid_file"
}

if [[ ! -f .env ]]; then
  echo "Missing $script_dir/.env; deployment configuration must remain on the VM." >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
  echo "Node.js 22.12+, npm, and curl are required." >&2
  exit 1
fi

echo "Installing locked dependencies."
npm ci
if [[ "${DEPLOY_RUN_TESTS:-false}" == "true" ]]; then
  echo "Running the full tracker verification suite."
  npm run verify
else
  echo "Skipping tracker tests; type-checking and building production artifacts."
  npm run typecheck
  npm run build
fi

stop_existing
trap cleanup_failed_start ERR

echo "Starting the production tracker."
nohup env LOG_FILE="$log_file" node dist/server/index.js >> "$bootstrap_log" 2>&1 &
new_pid=$!
printf '%s\n' "$new_pid" > "$pid_file"
sleep 1

health_url="$(node --input-type=module -e '
  import { loadEnvFile } from "node:process";
  loadEnvFile();
  const configured = process.env.HOST ?? "127.0.0.1";
  const host = configured === "0.0.0.0" || configured === "::" ? "127.0.0.1" : configured;
  const address = host.includes(":") ? `[${host}]` : host;
  console.log(`http://${address}:${process.env.PORT ?? "4310"}/api/readyz`);
')"

for _ in {1..20}; do
  if kill -0 "$new_pid" 2>/dev/null && curl -fsS --max-time 2 "$health_url" >/dev/null; then
    trap - ERR
    echo "Tracker deployed successfully as PID $new_pid ($health_url)."
    exit 0
  fi
  kill -0 "$new_pid" 2>/dev/null || break
  sleep 1
done

echo "Tracker failed its startup health check. Recent log output:" >&2
tail -n 80 "$log_file" >&2 || true
tail -n 80 "$bootstrap_log" >&2 || true
cleanup_failed_start
exit 1
