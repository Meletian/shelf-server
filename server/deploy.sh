#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == '--help' ]]; then
  printf '%s\n' '在已安装 Docker Engine 和 Docker Compose 的 Linux 服务器运行：bash server/deploy.sh' '首次询问域名与 Google OAuth 客户端配置；再次运行保留配置和数据。'
  exit 0
fi
if [[ $# -ne 0 || "$(uname -s)" != 'Linux' ]]; then
  printf '%s\n' '请在 Linux 服务器的解压目录运行 bash server/deploy.sh。' >&2
  exit 1
fi
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd -- "$ROOT"
if ! command -v docker >/dev/null 2>&1; then
  printf '%s\n' '未检测到 Docker。请先按官方说明安装 Docker Engine 和 Compose：https://docs.docker.com/engine/install/' >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  printf '%s\n' 'Docker 未启动、当前账号无权限或缺少 Compose。请修正后重试；必要时使用 sudo bash server/deploy.sh。' >&2
  exit 1
fi
STAGE='配置'
trap 'printf "部署未完成（%s）。已有配置和数据保留，请解决提示后重试。\n" "$STAGE" >&2' ERR
RUN=(docker run --rm -i)
if [[ -t 0 && -t 1 ]]; then RUN+=(-t); fi
"${RUN[@]}" --user 0:0 --mount "type=bind,source=$ROOT,target=/workspace" --workdir /workspace node:24-bookworm-slim node server/setup.mjs
STAGE='构建与启动'
docker compose --env-file server/.env -f server/compose.yml config --quiet
docker compose --env-file server/.env -f server/compose.yml up -d --build --wait --wait-timeout 180
STAGE='HTTPS 检查'
docker run --rm --user 0:0 --mount "type=bind,source=$ROOT,target=/workspace,readonly" --workdir /workspace node:24-bookworm-slim node server/setup.mjs --check
ORIGIN="$(docker run --rm --user 0:0 --mount "type=bind,source=$ROOT,target=/workspace,readonly" --workdir /workspace node:24-bookworm-slim node server/setup.mjs --origin)"
printf '部署完成。\nPWA：%s/app/\nGoogle 回调地址：%s/oauth/callback/google\n电脑与 iPhone 自配置快捷指令使用：%s\n' "$ORIGIN" "$ORIGIN" "$ORIGIN"
