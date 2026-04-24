#!/usr/bin/env bash
# Remove stock nginx :80 / server_name _; block (conflicts with ride-comfort.nginx.conf).
# Run: sudo bash trim-nginx-default.sh
set -euo pipefail
[ "${EUID:-$(id -u)}" -eq 0 ] || { echo "Run with sudo" >&2; exit 1; }
CONF="/etc/nginx/nginx.conf"
[ -f "$CONF" ] || exit 0
export CONF
python3.11 - <<'PY' 2>/dev/null || python3 - <<'PY'
import re, os, sys
p = os.environ["CONF"]
with open(p) as f:
    s = f.read()
pat = re.compile(
    r"    include /etc/nginx/conf.d/\*\.conf;\n\n    server \{\n        listen       80;\n        listen       \[::\]:80;\n        server_name  _;.*?\n    \}\n",
    re.S,
)
if not pat.search(s):
    sys.exit(0)
with open(p + ".bak2", "w") as f:
    f.write(s)
with open(p, "w") as f:
    f.write(pat.sub("    include /etc/nginx/conf.d/*.conf;\n", s, count=1))
sys.exit(2)
PY
st=$?
if [ "$st" -eq 2 ]; then
  nginx -t
  systemctl reload nginx
  echo "nginx default block removed, reloaded"
elif [ "$st" -eq 0 ]; then
  echo "no change (already trimmed or different nginx.conf)"
else
  exit "$st"
fi
