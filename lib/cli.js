#!/usr/bin/env node
/**
 * dsh-session-manager —— 命令行入口
 *
 * 直接调用 lib/core.js，不依赖 DSH 运行时，便于在 agent 工具之外独立操作、调试与批量处理。
 *
 * 用法：
 *   node lib/cli.js <action> [--key value | --key=value ...]
 *
 * action:
 *   list_workspaces
 *   list_sessions      [--workspace-id ID] [--search TEXT] [--no-archived]
 *   delete_session     --session-id ID [--no-clean-projcache] [--dry-run]
 *   move_session       --session-id ID --workspace-id ID [--allow-missing-target-dir] [--dry-run]
 */
import { dispatch, dshHome, sessionsRoot, workspaceFile, projcacheDir } from './core.js'

function parseArgv(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const eq = a.indexOf('=')
    let key, value
    if (eq >= 0) {
      key = a.slice(2, eq)
      value = a.slice(eq + 1)
    } else {
      key = a.slice(2)
      const nxt = argv[i + 1]
      if (nxt !== undefined && !nxt.startsWith('--')) {
        value = nxt
        i++
      } else {
        value = true
      }
    }
    const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    out[camel] = value === 'true' ? true : value === 'false' ? false : value
  }
  return out
}

const [action, ...rest] = process.argv.slice(2)

function usage() {
  process.stderr.write(
    [
      'dsh-session-manager',
      '',
      `DSH_HOME: ${dshHome()}`,
      `sessions : ${sessionsRoot()}`,
      `workspace: ${workspaceFile()}`,
      `projcache: ${projcacheDir()}`,
      '',
      'Usage:',
      '  node lib/cli.js list_workspaces',
      '  node lib/cli.js list_sessions [--workspace-id ID] [--search TEXT] [--no-archived]',
      '  node lib/cli.js delete_session --session-id ID [--no-clean-projcache] [--dry-run]',
      '  node lib/cli.js move_session --session-id ID --workspace-id ID [--allow-missing-target-dir] [--dry-run]',
    ].join('\n') + '\n',
  )
}

if (!action || action === '--help' || action === '-h' || action === 'help') {
  usage()
  process.exit(action ? 0 : 1)
}

const raw = parseArgv(rest)
const args = { ...raw }

if (action === 'list_sessions') {
  if (raw.workspaceId) args.workspaceId = raw.workspaceId
  if (raw.search) args.search = raw.search
  args.includeArchived = raw.noArchived ? false : true
}
if (action === 'delete_session') {
  if (raw.sessionId) args.sessionId = raw.sessionId
  if (raw.noCleanProjcache) args.cleanProjcache = false
  else args.cleanProjcache = true
}
if (action === 'move_session') {
  if (raw.sessionId) args.sessionId = raw.sessionId
  if (raw.workspaceId) args.workspaceId = raw.workspaceId
  args.allowMissingTargetDir = raw.allowMissingTargetDir ? true : false
}
args.dryRun = raw.dryRun ? true : false

try {
  const result = dispatch(action, args)
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
} catch (error) {
  process.stderr.write(JSON.stringify({ ok: false, action, error: error?.message || String(error) }, null, 2) + '\n')
  process.exitCode = 1
}
