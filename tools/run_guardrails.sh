#!/usr/bin/env bash
# 主题自带护栏：一条条跑，之间留一点间隔（它们各自要起 headless Chrome 与静态服务器）
set -u
cd "$(dirname "$0")/.."
for t in make_icons_check verify_theme verify_hub140; do
  echo "===== $t ====="
  case "$t" in
    make_icons_check) node tools/make_icons.mjs --check ;;
    *) node "tools/$t.mjs" ;;
  esac
  echo "[exit $?]"
  sleep 2
done
