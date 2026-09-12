#!/usr/bin/env bash
# 启动本地签名 Web 工具。运行后浏览器会自动打开签名页面。
set -euo pipefail
exec node "$(cd "$(dirname "$0")" && pwd)/sign-tool/server.mjs"
