#!/usr/bin/env bash
# Local three-chain environment: Base (8545), Unichain (8546), Reactive (8547) + relayer.
#   ops/local.sh start   # anvils + build + deploy + relayer (logs in .local/)
#   ops/local.sh stop
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .local

stop() {
  for f in .local/*.pid; do [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null || true; rm -f "$f"; done
  echo "stopped"
}

start() {
  stop >/dev/null
  # 1 s blocks on the Reactive side mimic Omni; origins automine.
  anvil --port 8545 --chain-id 84532   --silent > .local/base.log 2>&1 & echo $! > .local/base.pid
  anvil --port 8546 --chain-id 1301    --silent > .local/uni.log 2>&1 & echo $! > .local/uni.pid
  anvil --port 8547 --chain-id 5318007 --silent > .local/reactive.log 2>&1 & echo $! > .local/reactive.pid
  for p in 8545 8546 8547; do
    for _ in $(seq 1 50); do cast chain-id --rpc-url http://127.0.0.1:$p >/dev/null 2>&1 && break; sleep 0.1; done
  done
  echo "anvils up"
  forge build >/dev/null
  node ops/export-abi.mjs
  node ops/deploy.mjs local
  node ops/relayer.mjs > .local/relayer.log 2>&1 & echo $! > .local/relayer.pid
  echo "relayer up (tail -f .local/relayer.log)"
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  *) echo "usage: $0 start|stop"; exit 1 ;;
esac
