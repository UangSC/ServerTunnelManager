#!/bin/sh
set -eu
# Finder does not inherit the interactive shell's Homebrew PATH.
PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
export PATH
PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
APP_DIR="$HOME/Library/Application Support/TunnelStudio"
if ! command -v node >/dev/null 2>&1; then
  echo "需要 Node.js 22 或更新版本。安装后重新运行（Homebrew: brew install node@24）。" >&2
  exit 1
fi
action=${1:-start}
if [ "$#" -gt 0 ]; then shift; fi
case "$action" in
  install) exec node "$PROJECT_DIR/portable/TunnelStudio/bin/install.mjs" "$@" ;;
  start|restart)
    # Install once. Use 'install' or 'update' explicitly to deploy source changes.
    if [ ! -f "$APP_DIR/bin/service.mjs" ]; then node "$PROJECT_DIR/portable/TunnelStudio/bin/install.mjs"; fi ;;
  update)
    if [ -f "$APP_DIR/bin/service.mjs" ]; then node "$APP_DIR/bin/service.mjs" stop; fi
    node "$PROJECT_DIR/portable/TunnelStudio/bin/install.mjs"
    action=start ;;
  stop|status)
    if [ ! -f "$APP_DIR/bin/service.mjs" ]; then echo "尚未安装 macOS 面板。"; exit 0; fi ;;
  *) echo "用法：bin/macos.sh install|start|stop|restart|status|update [--open]" >&2; exit 1 ;;
esac
exec node "$APP_DIR/bin/service.mjs" "$action" --enable-ssh "$@"
