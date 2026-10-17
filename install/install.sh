#!/usr/bin/env bash
# 中文注释：codex-compat 官方 macOS / Linux 安装引导脚本；只使用 npm 包名，不硬编码任何下载地址。
#
# 首次使用请先添加执行权限：
#   chmod +x install.sh
#
# 用法：
#   ./install.sh                  # 安装 npm 上的最新版 codex-compat
#   ./install.sh --version 0.1.0  # 安装指定版本
#   ./install.sh --dry-run        # 只打印将执行的命令，不做任何变更

set -euo pipefail

# 中文注释：最低支持的 Node 主版本，与 package.json 的 engines 字段保持一致
readonly MINIMUM_NODE_MAJOR=18

# 中文注释：参数默认值
DRY_RUN=0
VERSION='latest'

# 中文注释：输出用法说明（含 chmod +x 提示）
usage() {
  cat <<'USAGE'
用法：./install.sh [--version <版本号>] [--dry-run]

首次执行前请先添加执行权限：
  chmod +x install.sh

参数：
  --version <版本号>  指定要安装的 codex-compat 版本，默认 latest
  --dry-run           只打印将执行的命令，不做任何安装
  -h, --help          显示本帮助
USAGE
}

# 中文注释：统一的日志输出前缀
log() {
  echo "[install] $*"
}

# 中文注释：检查 Node.js 是否存在且主版本满足要求，不满足时打印安装指引并退出 1
check_node() {
  if ! command -v node >/dev/null 2>&1; then
    log '未检测到 Node.js，请先安装 Node.js 18 或更高版本（推荐 LTS 版本）。'
    log '  macOS：brew install node'
    log '  Linux：使用发行版包管理器安装 nodejs 与 npm（例如 apt install nodejs npm）'
    log '  也可以前往 Node.js 官方网站下载 LTS 安装包，安装完成后重新运行本脚本。'
    exit 1
  fi

  local raw_version
  local major
  raw_version="$(node -v 2>/dev/null || true)"
  major="${raw_version#v}"
  major="${major%%.*}"
  if ! printf '%s' "$major" | grep -Eq '^[0-9]+$'; then
    log "无法解析 Node.js 版本号：${raw_version:-<空>}，请重新安装 Node.js 18 或更高版本。"
    exit 1
  fi
  if [ "$major" -lt "$MINIMUM_NODE_MAJOR" ]; then
    log "当前 Node.js 版本为 ${raw_version}，低于要求的 v${MINIMUM_NODE_MAJOR}。"
    log '请先升级 Node.js 后重试：'
    log '  macOS：brew install node'
    log '  Linux：使用发行版包管理器升级 nodejs，或用 nvm 安装 LTS 版本'
    exit 1
  fi

  log "Node.js 版本：${raw_version}（满足 >= v${MINIMUM_NODE_MAJOR}）"
}

# 中文注释：npm 随 Node.js 一起安装，缺失时给出明确指引并退出 1
check_npm() {
  if ! command -v npm >/dev/null 2>&1; then
    log '未检测到 npm，请重新安装 Node.js（npm 随 Node.js 一起安装）。'
    exit 1
  fi
}

# 中文注释：执行命令；失败时打印错误并退出 1
run_command() {
  log "执行：$*"
  if ! "$@"; then
    log "命令执行失败：$*"
    exit 1
  fi
}

# 中文注释：参数解析
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --version)
      if [ "$#" -lt 2 ]; then
        log '参数 --version 缺少版本号。'
        exit 1
      fi
      VERSION="$2"
      shift 2
      ;;
    --version=*)
      VERSION="${1#*=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      log "未知参数：$1"
      usage
      exit 1
      ;;
  esac
done

# 中文注释：安装主流程
main() {
  log 'codex-compat 安装引导开始。'
  check_node
  check_npm

  # 中文注释：默认安装 npm 上最新的 codex-compat；指定版本时使用“包名@版本”形式
  local package_spec='codex-compat'
  if [ -n "$VERSION" ] && [ "$VERSION" != 'latest' ]; then
    package_spec="codex-compat@${VERSION}"
  fi

  log '将执行以下命令：'
  log "  1) npm install -g ${package_spec}"
  log '  2) codex-compat install'

  if [ "$DRY_RUN" -eq 1 ]; then
    log 'DryRun 模式：未执行任何命令，退出码 0。'
    exit 0
  fi

  run_command npm install -g "$package_spec"
  run_command codex-compat install

  log '安装完成：重新启动 Codex 后生效。'
}

main "$@"
