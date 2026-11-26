/**
 * dsh-session-manager —— DSH 会话删除 / 跨工作区移动插件（Host 入口）
 *
 * 两条通道共用 lib/core.js 的纯文件系统实现：
 *   1) agent tool `session_manager`（tools 服务）
 *   2) 本地 webServer 路由 /session-manager/*，供 client 端会话 "..." 菜单调用
 *
 * 刻意只用 node:* 与本地相对导入：profile 的 node_modules 下没有
 * @deepseek-ai/* 的解析路径，本地 bundle 依赖它会加载失败
 * （参考已工作的 dsh-workbuddy：全部为 node:* + 相对导入）。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { dispatch, listWorkspaces, dshHome, sessionsRoot, workspaceFile } from './core.js'

export const name = 'dsh-session-manager'
export const inject = ['tools', 'webServer']

const ACTIONS = ['list_workspaces', 'list_sessions', 'delete_session', 'move_session', 'list_history', 'clear_history', 'restore_history', 'purge_history', 'purge_all_history', 'session_titles']

const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ACTIONS,
      description: '操作类型：list_workspaces=列出工作区分组；list_sessions=列出会话；delete_session=删除会话并清理本地会话日志与索引；move_session=把会话移动到指定工作区（改写会话头 cwd + 迁移物理目录 + 更新工作区成员）。',
    },
    sessionId: {
      type: 'string',
      description: '会话 id，形如 session-<uuid>。delete_session / move_session 必填；先调用 list_sessions 获取。',
    },
    workspaceId: {
      type: 'string',
      description: '目标工作区 id。move_session 必填；list_sessions 时可选，用于按工作区过滤。先调用 list_workspaces 获取。',
    },
    search: {
      type: 'string',
      description: 'list_sessions 时按 id / agentPreset / 工作区标题 / cwd 做小写子串筛选。',
    },
    includeArchived: {
      type: 'boolean',
      description: 'list_sessions 是否包含已归档会话，默认 true。',
    },
    cleanProjcache: {
      type: 'boolean',
      description: 'delete_session 是否一并清理 session_projcache 派生缓存，默认 true。',
    },
    allowMissingTargetDir: {
      type: 'boolean',
      description: 'move_session 目标工作区目录不存在时是否强制移动，默认 false。真实项目目录一般存在；网络盘掉线时可强制。',
    },
    dryRun: {
      type: 'boolean',
      description: '为 true 时只返回将要发生的变更，不落盘。默认 false。删除/移动前建议先 dryRun。',
    },
    entryId: {
      type: 'string',
      description: 'restore_history / purge_history 必填：历史记录 id（从 list_history 获取）。restore_history 从回收站恢复误删会话；purge_history 彻底删除该条记录的回收站文件（不可恢复）。',
    },
    sessionIds: {
      type: 'array',
      items: { type: 'string' },
      description: 'session_titles 必填：要查询当前命名的会话 id 数组。返回每个会话的首条用户消息文本（即侧栏标题），已删除的从回收站日志读取。',
    },
  },
  required: ['action'],
}

const textRender = (_args, value) => [{ type: 'text', text: value }]

const MAX_BODY_BYTES = 1024 * 1024

function json(response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  response.end(payload)
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

/** 只接受本机页面发起的调用：跨站请求一律拒绝。 */
function sameOrigin(request) {
  const site = request.headers['sec-fetch-site']
  if (typeof site === 'string' && site === 'cross-site') return false
  const origin = request.headers.origin
  const host = request.headers.host
  if (typeof origin === 'string' && origin !== '' && typeof host === 'string' && host !== '') {
    try {
      return new URL(origin).host === host
    } catch {
      return false
    }
  }
  return true
}

/** 重启 DeepSeek Harness：优先 Electron 原生 relaunch（优雅退出），失败则用分离式 cmd 助手强杀全部实例后重新拉起。 */
function performRestart(response) {
  const sendOk = (method) => json(response, 200, { ok: true, method, note: '重启指令已发出，界面将在几秒内断开并自动恢复。' })
  let done = false
  // 方式 1：Electron 原生 relaunch（优雅，窗口正常关闭后重启）
  Promise.race([
    import('electron').then((m) => {
      const app = m?.app || m?.default?.app
      if (!app || typeof app.relaunch !== 'function') throw new Error('electron app unavailable')
      return app
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 800)),
  ])
    .then((app) => {
      if (done) return
      done = true
      sendOk('electron-relaunch')
      setTimeout(() => {
        try { app.relaunch(); app.exit(0) } catch { /* 兑底助手已发车也无妨 */ }
      }, 500)
    })
    .catch(() => {
      if (done) return
      done = true
      // 方式 2：分离式 cmd 助手（不随宿主退出而死亡）：2 秒后强杀全部实例并重新拉起
      const exe = process.execPath
      const name = path.basename(exe)
      const cmd = `timeout /t 2 /nobreak >nul & taskkill /F /IM "${name}" >nul 2>&1 & start "" "${exe}"`
      const helper = spawn('cmd.exe', ['/d', '/s', '/c', cmd], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      helper.unref()
      sendOk('detached-helper')
    })
}

export function apply(ctx) {
  // ---- 1) agent tool ----------------------------------------------------
  ctx.tools.register({
    name: 'session_manager',
    description:
      '管理 DeepSeek Harness 的会话与工作区分组。DSH 自带 UI 只能归档会话，本工具补上：' +
      '（1）delete_session 彻底删除会话，连带把本地 session.v4.jsonl.zstd 日志移入回收站、清出 workspace.json 中的成员/归档/置顶记录并清理 session_projcache 缓存（可 restore_history 撤销）；' +
      '（2）move_session 把会话移动到任意工作区分组，会改写会话头 cwd、迁移物理会话目录并更新工作区成员关系；' +
      '（3）list_workspaces / list_sessions 用于先列出可选目标；' +
      '（4）list_history 查看删除/移动审计日志，clear_history 清空日志，restore_history 从回收站恢复误删会话。所有写操作支持 dryRun 预演。' +
      `数据目录：DSH_HOME=${dshHome()}，sessions=${sessionsRoot()}，workspace=${workspaceFile()}。`,
    parameters: PARAMETERS,
    output: { schema: { type: 'string' }, render: textRender },
    async execute(args) {
      const action = args?.action
      if (!ACTIONS.includes(action)) throw new Error(`unknown action: ${action}`)
      let result
      try {
        result = dispatch(action, args || {})
      } catch (error) {
        return JSON.stringify({ ok: false, action, error: error?.message || String(error) })
      }
      return JSON.stringify(result, null, 2)
    },
    presentCall(args) {
      const write = args?.action === 'delete_session' || args?.action === 'move_session'
      return {
        card: 'generic',
        title: write ? '会话管理 · 写入' : '会话管理 · 查询',
        kind: write ? 'write' : 'read',
      }
    },
  })

  // ---- 2) 供 client 会话菜单调用的本地 HTTP 路由 ------------------------
  const routes = []
  const register = (kind, routePath, handler) => {
    const spec = {
      kind,
      path: routePath,
      handler: async (request, response) => {
        if (!sameOrigin(request)) {
          json(response, 403, { ok: false, error: 'cross-site request refused' })
          return
        }
        try {
          await handler(request, response)
        } catch (error) {
          if (!response.headersSent) json(response, 500, { ok: false, error: String(error?.message ?? error) })
          else response.end()
        }
      },
    }
    routes.push(ctx.effect(() => ctx.webServer.register(spec), `session-manager: route ${routePath}`))
  }

  register('exact', '/session-manager/workspaces', async (_request, response) => {
    json(response, 200, { ok: true, workspaces: listWorkspaces() })
  })

  register('exact', '/session-manager/sessions', async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    const workspaceId = url.searchParams.get('workspaceId') || undefined
    const search = url.searchParams.get('search') || undefined
    json(response, 200, { ok: true, sessions: dispatch('list_sessions', { workspaceId, search }) })
  })

  register('exact', '/session-manager/delete', async (request, response) => {
    if (request.method !== 'POST') {
      json(response, 405, { ok: false, error: 'POST only' })
      return
    }
    const body = JSON.parse((await readBody(request)) || '{}')
    if (typeof body.sessionId !== 'string' || body.sessionId.trim() === '') {
      json(response, 400, { ok: false, error: 'sessionId is required' })
      return
    }
    const result = dispatch('delete_session', {
      sessionId: body.sessionId,
      cleanProjcache: body.cleanProjcache !== false,
      dryRun: body.dryRun === true,
    })
    json(response, 200, result)
  })

  register('exact', '/session-manager/history', async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    const action = url.searchParams.get('action') || undefined
    const limit = url.searchParams.get('limit') || undefined
    json(response, 200, { ok: true, entries: dispatch('list_history', { action, limit: limit ? Number(limit) : undefined }) })
  })

  register('exact', '/session-manager/history/clear', async (request, response) => {
    if (request.method !== 'POST') {
      json(response, 405, { ok: false, error: 'POST only' })
      return
    }
    json(response, 200, dispatch('clear_history'))
  })

  register('exact', '/session-manager/history/restore', async (request, response) => {
    if (request.method !== 'POST') {
      json(response, 405, { ok: false, error: 'POST only' })
      return
    }
    const body = JSON.parse((await readBody(request)) || '{}')
    if (typeof body.entryId !== 'string' || body.entryId.trim() === '') {
      json(response, 400, { ok: false, error: 'entryId is required' })
      return
    }
    const result = dispatch('restore_history', { entryId: body.entryId })
    json(response, 200, result)
  })

  register('exact', '/session-manager/history/purge', async (request, response) => {
    if (request.method !== 'POST') {
      json(response, 405, { ok: false, error: 'POST only' })
      return
    }
    const body = JSON.parse((await readBody(request)) || '{}')
    if (typeof body.entryId !== 'string' || body.entryId.trim() === '') {
      json(response, 400, { ok: false, error: 'entryId is required' })
      return
    }
    json(response, 200, dispatch('purge_history', { entryId: body.entryId }))
  })

  register('exact', '/session-manager/history/purge-all', async (request, response) => {
    if (request.method !== 'POST') {
      json(response, 405, { ok: false, error: 'POST only' })
      return
    }
    json(response, 200, dispatch('purge_all_history'))
  })

  register('exact', '/session-manager/session-titles', async (request, response) => {
    if (request.method !== 'POST') {
      json(response, 405, { ok: false, error: 'POST only' })
      return
    }
    const body = JSON.parse((await readBody(request)) || '{}')
    if (!Array.isArray(body.sessionIds)) {
      json(response, 400, { ok: false, error: 'sessionIds array is required' })
      return
    }
    json(response, 200, { ok: true, titles: dispatch('session_titles', { sessionIds: body.sessionIds }) })
  })

  register('exact', '/session-manager/restart', async (request, response) => {
    if (request.method !== 'POST') {
      json(response, 405, { ok: false, error: 'POST only' })
      return
    }
    performRestart(response)
  })

  register('exact', '/session-manager/move', async (request, response) => {
    if (request.method !== 'POST') {
      json(response, 405, { ok: false, error: 'POST only' })
      return
    }
    const body = JSON.parse((await readBody(request)) || '{}')
    if (typeof body.sessionId !== 'string' || typeof body.workspaceId !== 'string') {
      json(response, 400, { ok: false, error: 'sessionId and workspaceId are required' })
      return
    }
    const result = dispatch('move_session', {
      sessionId: body.sessionId,
      workspaceId: body.workspaceId,
      dryRun: body.dryRun === true,
      allowMissingTargetDir: body.allowMissingTargetDir === true,
    })
    json(response, 200, result)
  })

  ctx.effect(() => () => {
    for (const dispose of routes) dispose()
  }, 'session-manager: routes')
}
