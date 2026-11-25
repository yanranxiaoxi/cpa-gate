#!/bin/sh
# cpa-gate + keycordon 双进程入口。
# 任一进程退出即整体退出（fail fast），避免「开关显示已启用但实际没生效」。
set -eu

die() { echo "[entrypoint] $*" >&2; exit 1; }

[ -n "${KEYCORDON_MASTER_KEY:-}" ] \
  || die "KEYCORDON_MASTER_KEY is required (hex or base64 of at least 32 bytes)"

UPSTREAM="${KEYCORDON_UPSTREAM:-${CPA_MANAGEMENT_URL:-}}"
[ -n "$UPSTREAM" ] \
  || die "KEYCORDON_UPSTREAM is empty and CPA_MANAGEMENT_URL is not set"

# 防止把 keycordon 自己当成上游：一旦成环，请求会在两个代理之间往返
case "$UPSTREAM" in
  *:8318|*:8318/*) die "KEYCORDON_UPSTREAM must not point at keycordon itself (8318): $UPSTREAM" ;;
esac

# 容器内的 127.0.0.1 指向容器自己；除非上游与本站同容器，否则通常配错了
case "$UPSTREAM" in
  http://127.0.0.1:*|http://localhost:*|'http://[::1]:'*)
    echo "[entrypoint] warn: KEYCORDON_UPSTREAM=$UPSTREAM is loopback; nothing is likely listening there in this container" >&2 ;;
esac

echo "[entrypoint] keycordon upstream: $UPSTREAM"

keycordon serve -config /etc/keycordon/config.yaml -upstream "$UPSTREAM" &
KC_PID=$!
node /home/node/app/index.js &
NODE_PID=$!

shutdown() {
  trap - TERM INT
  kill -TERM "$KC_PID" "$NODE_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  exit 0
}
trap shutdown TERM INT

# 轮询存活：BusyBox ash 没有可移植的 `wait -n`，这里用 kill -0 判断
rc=0
while kill -0 "$KC_PID" 2>/dev/null && kill -0 "$NODE_PID" 2>/dev/null; do
  sleep 1
done
if ! kill -0 "$KC_PID" 2>/dev/null; then
  wait "$KC_PID" || rc=$?
  echo "[entrypoint] keycordon exited (rc=$rc); stopping container" >&2
else
  wait "$NODE_PID" || rc=$?
  echo "[entrypoint] cpa-gate exited (rc=$rc); stopping container" >&2
fi

trap - TERM INT
kill -TERM "$KC_PID" "$NODE_PID" 2>/dev/null || true
wait 2>/dev/null || true
exit "$rc"
