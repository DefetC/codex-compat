// 版本与帮助信息。
const config = require('../config.cjs');

// 中文注释：帮助文本
function helpText() {
  return [
    'codex-compat v' + config.version(),
    '',
    '用法：',
    '  codex-compat                     交互式菜单',
    '  codex-compat <命令> [选项]       脚本化调用',
    '',
    '命令：',
    '  install / repair                 安装或修复（预检 → 备份 → 写入 → 起服务 → 自检）',
    '  start / pause / stop / restart   启动 / 临时暂停 / 完全停止 / 重启',
    '  status                           状态总览',
    '  doctor [--fix]                   体检与修复',
    '  logs [--lines N] [--follow]      查看日志',
    '  config list|get|set              读写配置',
    '  templates [--force] [--dry-run]  把包内模板与提示词刷新到运行目录（第一跳）',
    '  bypass                           应急旁路：base_url 指回原上游',
    '  restore                          按安装清单还原',
    '  uninstall [--purge]              卸载（可选删除运行目录）',
    '  instance <子命令>（别名 lab）     实验实例：多开 / 临时 Codex',
    '     子命令：create | list | status | start | stop | env | run | refresh-catalog | update | remove',
    '     创建参数：--provider --model --models --key --key-env --port --catalog-mode --autostart',
    '     典型用法：先 instance create 试跑，再 instance run 拉起临时 Codex CLI',
    '  bundle / diagnose                生成脱敏诊断包',
    '  selftest                         离线改写用例 + 运行态自检',
    '  version / help                   版本与帮助',
    '',
    '全局选项：--json --dry-run --yes --verbose --port --upstream --home --reclaim --allow-remote-upstream --force-roles',
    '',
    '--force-roles：仅当所有权记录指向同一个角色文件时，允许用当前模板覆盖该角色（工具升级迁移用）',
    '--refresh-config：install / repair 时用包内模板与提示词覆盖运行目录（用户改过的 mappings 会被一起替换）',
    '--refresh-templates：install / repair 时顺带按受管语义刷新模板与提示词（不覆盖本地改过的）',
    '--force：与 templates / --refresh-templates 一起用时，连本地改过的模板一并覆盖（覆盖前备份）',
    '--verbose：输出排查细节（解析路径、端口尝试明细、原始探测结果、异常堆栈、最近系统命令）',
  ].join('\n');
}

// 中文注释：版本命令
async function version() {
  return { ok: true, code: 'version', lines: ['codex-compat v' + config.version()], version: config.version() };
}

// 中文注释：帮助命令
async function help() {
  return { ok: true, code: 'help', lines: helpText().split('\n') };
}

module.exports = { version, help, helpText };
