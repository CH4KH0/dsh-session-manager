/**
 * dsh-session-manager —— client 入口（web 平台）
 *
 * 1) 侧栏会话 "..." 菜单：
 *    - 删除会话（含本地文件）  —— POST /session-manager/delete（进回收站，可恢复）
 *    - 移动到工作区…（子菜单列出所有工作区） —— POST /session-manager/move
 * 2) 左侧栏「会话管理」面板：
 *    - 删除/移动审计日志（时间、会话、工作区、清理内容）
 *    - 误删一键恢复（从回收站回滚物理文件并重新挂回工作区）
 *    - 清空日志
 *
 * 所有执行都经过用户显式确认；Host 侧路由做同源校验并复用 lib/core.js。
 */
;(function () {
  window.__ModuleLoader__.load({
    id: 'dsh-session-manager',
    factory: (require) => {
      const inject = ['contextMenus', 'slots']

      var react = require('react')
      var el = react.createElement

      var PLUGIN_ID = 'dsh-session-manager'
      var PANEL_ID = 'session-manager-panel'

      async function call(pathname, init) {
        const response = await fetch(pathname, {
          ...init,
          headers: { 'content-type': 'application/json', ...(init && init.headers) },
        })
        const text = await response.text()
        let payload
        try {
          payload = JSON.parse(text)
        } catch {
          payload = { ok: false, error: text.slice(0, 300) }
        }
        if (!response.ok && payload.ok !== false) payload.ok = false
        return payload
      }

      function done(message) {
        try {
          window.alert(message)
        } catch {
          console.info(message)
        }
      }

      function fail(action, result) {
        const detail = (result && result.error) || '未知错误'
        window.alert(action + '失败：' + detail)
      }

      function apply(ctx) {
        // ------------------------------------------------ 1) 会话右键菜单
        ctx.effect(() => ctx.contextMenus.register({
          id: 'session.delete',
          target: 'session',
          order: 900,
          resolve: async (target) => {
            const sessionId = target && target.sessionId
            if (!sessionId) return []

            let workspaces = []
            try {
              const result = await call('/session-manager/workspaces')
              if (result && result.ok && Array.isArray(result.workspaces)) workspaces = result.workspaces
            } catch {
              /* 工作区列表读取失败时，移动子菜单留空，删除仍可用 */
            }

            const moveChildren = workspaces.map((workspace) => {
              const label = workspace.title || workspace.path || workspace.id
              return {
                id: 'move-to-' + workspace.id,
                label: '移动到：' + label,
                run: async () => {
                  if (!window.confirm(
                    '把会话移动到「' + label + '」？\n\n' +
                    '会改写会话头 cwd、迁移本地会话目录并更新工作区归属。',
                  )) return
                  let result
                  try {
                    result = await call('/session-manager/move', {
                      method: 'POST',
                      body: JSON.stringify({ sessionId, workspaceId: workspace.id }),
                    })
                  } catch (error) {
                    fail('移动', { error: String(error) })
                    return
                  }
                  if (!result || result.ok !== true) return fail('移动', result)
                  done('已移动到「' + label + '」。重启 DSH 后该会话会从新分组显示（当前运行中的索引是旧值）。')
                },
              }
            })

            return [
              {
                id: 'delete',
                label: '删除会话（含本地文件）',
                icon: { key: 'workspace.delete' },
                danger: true,
                separatorBefore: true,
                afterContent: true,
                run: async () => {
                  if (!window.confirm(
                    '确定删除该会话？\n\n' +
                    '会话 id：' + sessionId + '\n\n' +
                    '本地日志与缓存将移入回收站（可在左侧「会话管理」面板一键恢复），工作区索引同步清除。',
                  )) return
                  let result
                  try {
                    result = await call('/session-manager/delete', {
                      method: 'POST',
                      body: JSON.stringify({ sessionId, cleanProjcache: true }),
                    })
                  } catch (error) {
                    fail('删除', { error: String(error) })
                    return
                  }
                  if (!result || result.ok !== true) return fail('删除', result)
                  const freed = typeof result.removedBytes === 'number' ? result.removedBytes : 0
                  done('会话已删除（物理文件已移入回收站，可在「会话管理」面板恢复），释放 ' + freed + ' 字节。重启 DSH 后从列表消失。')
                },
              },
              {
                id: 'move',
                label: '移动到工作区…',
                icon: { key: 'workspace.rename' },
                children: moveChildren,
              },
            ]
          },
        }), 'dsh-session-manager: session menu')

        // ------------------------------------------------ 2) 左侧栏入口
        try {
          ctx.slots.inject('sidebar.panellist', function () {
            return ctx.slots.register(
              { name: 'sidebar.panellist', id: PANEL_ID, order: 56, label: function () { return '会话管理' } },
              function () {
                return el('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': true },
                  // 图标：目录 + 场景切换（层叠方块）
                  el('path', { d: 'M1.5 3.5A1.5 1.5 0 0 1 3 2h3.2l1.4 1.6H13a1.5 1.5 0 0 1 1.5 1.5v1.2h-1.2V5.1a.3.3 0 0 0-.3-.3H7.2L5.8 3.2H3a.3.3 0 0 0-.3.3v7a.3.3 0 0 0 .3.3h4.4v1.2H3a1.5 1.5 0 0 1-1.5-1.5v-7z' }),
                  el('path', { d: 'M9 8.4l3.2-1.5 3.2 1.5-3.2 1.5L9 8.4zm0 2.6l3.2 1.5 3.2-1.5v1.6L12.2 14 9 12.6V11z' })
                )
              }
            )
          })
        } catch (e) { console.warn('[session-manager] sidebar slot error', e) }

        try {
          ctx.slots.inject('main', function () {
            return ctx.slots.register({ name: 'main', key: PANEL_ID }, function (props) {
              return el(SmPanel, Object.assign({}, props, { smctx: ctx }))
            })
          })
        } catch (e) { console.warn('[session-manager] main slot error', e) }
      }

      // ------------------------------------------------ 面板组件
      var CSS = `
.sm-root { box-sizing: border-box; height: 100%; overflow-y: auto; padding: 20px 24px 40px;
  font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-primary, #e2e8f0);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  background: var(--dsw-alias-bg-module-platform, transparent); }
.sm-head { display: flex; align-items: center; gap: 12px; margin-bottom: 6px; flex-wrap: wrap; }
.sm-title { font-size: 17px; font-weight: 600; letter-spacing: .2px; }
.sm-sub { color: var(--dsw-alias-label-secondary, #94a3b8); font-size: 12px; margin-bottom: 14px; }
.sm-spacer { flex: 1; }
.sm-btn { appearance: none; border: 1px solid var(--dsw-alias-border-primary, #334155);
  background: var(--dsw-alias-bg-control-secondary, rgba(148,163,184,.08));
  color: var(--dsw-alias-label-primary, #e2e8f0); border-radius: 8px; padding: 5px 12px;
  font-size: 12px; cursor: pointer; transition: background .15s ease; }
.sm-btn:hover { background: var(--dsw-alias-bg-control-hover, rgba(148,163,184,.16)); }
.sm-btn:disabled { opacity: .45; cursor: not-allowed; }
.sm-btn.danger { color: #fca5a5; border-color: rgba(239,68,68,.35); }
.sm-btn.danger:hover { background: rgba(239,68,68,.14); }
.sm-stats { display: flex; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
.sm-stat { border: 1px solid var(--dsw-alias-border-secondary, rgba(148,163,184,.18));
  border-radius: 10px; padding: 8px 14px; min-width: 96px;
  background: var(--dsw-alias-bg-control-secondary, rgba(148,163,184,.06)); }
.sm-stat b { display: block; font-size: 18px; font-weight: 600; font-variant-numeric: tabular-nums; }
.sm-stat span { font-size: 11px; color: var(--dsw-alias-label-secondary, #94a3b8); }
.sm-tabs { display: inline-flex; gap: 2px; border: 1px solid var(--dsw-alias-border-secondary, rgba(148,163,184,.18));
  border-radius: 9px; padding: 2px; margin-bottom: 12px;
  background: var(--dsw-alias-bg-control-secondary, rgba(148,163,184,.06)); }
.sm-tab { appearance: none; border: none; background: transparent; color: var(--dsw-alias-label-secondary, #94a3b8);
  border-radius: 7px; padding: 4px 14px; font-size: 12px; cursor: pointer; }
.sm-tab.active { background: var(--dsw-alias-bg-control-primary, rgba(148,163,184,.18));
  color: var(--dsw-alias-label-primary, #e2e8f0); font-weight: 500; }
.sm-table-wrap { border: 1px solid var(--dsw-alias-border-secondary, rgba(148,163,184,.18));
  border-radius: 12px; overflow: hidden; }
.sm-table { width: 100%; table-layout: fixed; border-collapse: collapse; font-variant-numeric: tabular-nums; }
.sm-table th { text-align: left; font-size: 11px; font-weight: 500; letter-spacing: .4px;
  color: var(--dsw-alias-label-secondary, #94a3b8); padding: 9px 14px;
  background: var(--dsw-alias-bg-control-secondary, rgba(148,163,184,.08));
  border-bottom: 1px solid var(--dsw-alias-border-secondary, rgba(148,163,184,.18));
  position: relative; user-select: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sm-table th[draggable="true"] { cursor: grab; }
.sm-table th.sm-drag-over { box-shadow: inset 2px 0 0 0 #60a5fa; }
.sm-col-resizer { position: absolute; right: -5px; top: 0; width: 11px; height: 100%; cursor: col-resize; z-index: 2; }
.sm-col-resizer:hover { background: rgba(148,163,184,.28); }
.sm-session-title { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sm-table td { padding: 10px 14px; font-size: 12.5px; vertical-align: middle;
  border-bottom: 1px solid var(--dsw-alias-border-secondary, rgba(148,163,184,.12)); }
.sm-table tr:last-child td { border-bottom: none; }
.sm-table tr:hover td { background: var(--dsw-alias-bg-control-secondary, rgba(148,163,184,.05)); }
.sm-act { display: inline-flex; align-items: center; gap: 6px; font-weight: 500; white-space: nowrap; }
.sm-act .dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
.sm-dot-del { background: #ef4444; } .sm-dot-move { background: #3b82f6; }
.sm-badge { display: inline-block; border-radius: 6px; padding: 2px 8px; font-size: 11px; white-space: nowrap; }
.sm-badge.ok { color: #6ee7b7; background: rgba(16,185,129,.12); border: 1px solid rgba(16,185,129,.25); }
.sm-badge.pend { color: #fcd34d; background: rgba(245,158,11,.12); border: 1px solid rgba(245,158,11,.25); }
.sm-badge.err { color: #fca5a5; background: rgba(239,68,68,.12); border: 1px solid rgba(239,68,68,.25); }
.sm-title-cell { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sm-muted { color: var(--dsw-alias-label-secondary, #94a3b8); font-size: 11.5px; }
.sm-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; }
.sm-empty { padding: 48px 0; text-align: center; color: var(--dsw-alias-label-secondary, #94a3b8); }
.sm-restore { appearance: none; border: 1px solid rgba(16,185,129,.35); background: rgba(16,185,129,.1);
  color: #6ee7b7; border-radius: 7px; padding: 3px 10px; font-size: 11.5px; cursor: pointer; white-space: nowrap; }
.sm-restore:hover { background: rgba(16,185,129,.2); }
.sm-restore:disabled { opacity: .4; cursor: not-allowed; }
.sm-purge { appearance: none; border: 1px solid rgba(239,68,68,.35); background: rgba(239,68,68,.1);
  color: #fca5a5; border-radius: 7px; padding: 3px 10px; font-size: 11.5px; cursor: pointer; white-space: nowrap; }
.sm-purge:hover { background: rgba(239,68,68,.2); }
.sm-purge:disabled { opacity: .4; cursor: not-allowed; }
.sm-status-cell { display: flex; gap: 6px; align-items: center; }
`

      function fmtBytes(n) {
        if (typeof n !== 'number' || n <= 0) return '—'
        if (n < 1024) return n + ' B'
        if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'
        return (n / 1048576).toFixed(2) + ' MB'
      }
      function fmtTime(iso) {
        if (!iso) return '—'
        try {
          var d = new Date(iso)
          if (isNaN(d.getTime())) return iso
          var p = function (x) { return (x < 10 ? '0' : '') + x }
          return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
        } catch { return iso }
      }
      function titleOf(e) {
        return e.sessionTitle || (e.sessionId || '').slice(0, 20) || '（未知会话）'
      }

      // ------------------------------------------------ 列布局（顺序 + 宽度，持久化到 localStorage）
      var COL_STORE_KEY = 'sm-panel-cols-v1'
      var DEFAULT_COLS = [
        { key: 'time', label: '时间', width: 150 },
        { key: 'action', label: '动作', width: 80 },
        { key: 'session', label: '会话（当前命名）', width: 280 },
        { key: 'workspace', label: '工作区', width: 190 },
        { key: 'content', label: '内容', width: 180 },
        { key: 'status', label: '状态', width: 190 },
      ]
      function loadCols() {
        try {
          var saved = JSON.parse(window.localStorage.getItem(COL_STORE_KEY))
          if (Array.isArray(saved) && saved.length > 0 &&
              saved.every(function (c) { return c && typeof c.key === 'string' && typeof c.width === 'number' && DEFAULT_COLS.some(function (d) { return d.key === c.key }) }) &&
              saved.length === DEFAULT_COLS.length) return saved
        } catch {}
        return DEFAULT_COLS.slice()
      }
      function saveCols(cols) {
        try { window.localStorage.setItem(COL_STORE_KEY, JSON.stringify(cols)) } catch {}
      }

      function SmPanel(props) {
        var entriesPair = react.useState(null)   // null=加载中
        var entries = entriesPair[0], setEntries = entriesPair[1]
        var filterPair = react.useState('all')
        var filter = filterPair[0], setFilter = filterPair[1]
        var busyPair = react.useState(false)
        var busy = busyPair[0], setBusy = busyPair[1]
        var errPair = react.useState('')
        var err = errPair[0], setErr = errPair[1]
        var colsPair = react.useState(loadCols)
        var cols = colsPair[0], setCols = colsPair[1]
        var titlesPair = react.useState({})          // sessionId -> {title, source}
        var titles = titlesPair[0], setTitles = titlesPair[1]

        var reload = react.useCallback(function (silent) {
          if (!silent) { setBusy(true); setErr('') }
          fetch('/session-manager/history?limit=300')
            .then(function (r) { return r.json() })
            .then(function (j) {
              var list = j && Array.isArray(j.entries) ? j.entries : []
              // 拉取每条会话的「当前命名」（日志最后的 session/title 事件；已删除的从回收站日志读）
              var ids = []
              var seen = {}
              for (var i = 0; i < list.length; i++) {
                var sid = list[i].sessionId
                if (sid && !seen[sid]) { seen[sid] = true; ids.push(sid) }
              }
              var titlesPromise = ids.length
                ? fetch('/session-manager/session-titles', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ sessionIds: ids }),
                  })
                    .then(function (r) { return r.json() })
                    .catch(function () { return null })
                : Promise.resolve(null)
              return Promise.all([Promise.resolve(list), titlesPromise])
            })
            .then(function (res) {
              var list = res[0]
              var t = res[1] && res[1].ok && res[1].titles ? res[1].titles : null
              // 静默轮询：数据无变化时不触发重渲染
              var snapshot = JSON.stringify([list, t])
              if (silent && snapshot === lastData.current) return
              lastData.current = snapshot
              setEntries(list)
              if (t) setTitles(t)
            })
            .catch(function (e) {
              if (!silent) { setErr(String(e && e.message || e)); setEntries([]) }
            })
            .finally(function () { if (!silent) setBusy(false) })
        }, [])
        var lastData = react.useRef('')
        react.useEffect(function () {
          reload(false)
          // 自动刷新：每 5 秒静默轮询，更名/删除/移动自动同步
          var timer = setInterval(function () { reload(true) }, 5000)
          return function () { clearInterval(timer) }
        }, [reload])

        // ------------------------------------------------ 表头拖动换位 + 拖拽调列宽
        var dragFrom = react.useRef(-1)
        var onThDragStart = function (i) {
          return function (e) {
            dragFrom.current = i
            e.dataTransfer.effectAllowed = 'move'
            try { e.dataTransfer.setData('text/plain', String(i)) } catch {}
          }
        }
        var onThDragOver = function (e) { e.preventDefault() }
        var onThDrop = function (i) {
          return function (e) {
            e.preventDefault()
            var from = dragFrom.current
            dragFrom.current = -1
            if (from < 0 || from === i) return
            setCols(function (prev) {
              var next = prev.slice()
              var moved = next.splice(from, 1)[0]
              next.splice(i, 0, moved)
              saveCols(next)
              return next
            })
          }
        }
        var startResize = function (colKey) {
          return function (e) {
            e.preventDefault()
            e.stopPropagation()
            var col = cols.find(function (c) { return c.key === colKey })
            var startX = e.clientX
            var startW = (col && col.width) || 120
            var move = function (ev) {
              var w = Math.max(60, startW + ev.clientX - startX)
              setCols(function (prev) {
                return prev.map(function (c) { return c.key === colKey ? Object.assign({}, c, { width: w }) : c })
              })
            }
            var up = function () {
              document.removeEventListener('mousemove', move)
              document.removeEventListener('mouseup', up)
              setCols(function (prev) { saveCols(prev); return prev })
            }
            document.addEventListener('mousemove', move)
            document.addEventListener('mouseup', up)
          }
        }

        var clearAll = react.useCallback(function () {
          if (!window.confirm('确定清空全部操作日志？（回收站文件不受影响）')) return
          fetch('/session-manager/history/clear', { method: 'POST' })
            .then(function (r) { return r.json() })
            .then(function (j) { if (j && j.ok) reload() })
            .catch(function (e) { setErr(String(e && e.message || e)) })
        }, [reload])

        var restore = react.useCallback(function (entry) {
          if (!window.confirm('恢复会话「' + titleOf(entry) + '」？\n\n物理文件将从回收站回滚到原位，并重新挂回工作区「' + (entry.workspaceTitle || '未知') + '」。')) return
          setBusy(true)
          fetch('/session-manager/history/restore', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ entryId: entry.id }),
          })
            .then(function (r) { return r.json() })
            .then(function (j) {
              if (j && j.ok) { window.alert('已恢复会话「' + titleOf(entry) + '」（' + (j.restoredFiles || 0) + ' 个文件回滚）。重启 DSH 后重新显示。'); reload() }
              else fail('恢复', j)
            })
            .catch(function (e) { fail('恢复', { error: String(e) }) })
            .finally(function () { setBusy(false) })
        }, [reload])

        var purgeOne = react.useCallback(function (entry) {
          if (!window.confirm(
            '彻底删除「' + titleOf(entry) + '」的回收站文件？\n\n' +
            '该会话的本地日志与缓存将从磁盘上永久清除，之后无法再恢复！\n' +
            '（只清理本条记录登记的文件，不影响回收站里其他内容）'
          )) return
          setBusy(true)
          fetch('/session-manager/history/purge', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ entryId: entry.id }),
          })
            .then(function (r) { return r.json() })
            .then(function (j) {
              if (j && j.ok) { window.alert('已彻底删除（' + (j.removedFiles || 0) + ' 个文件，释放 ' + fmtBytes(j.removedBytes) + '）。该记录不可再恢复。'); reload() }
              else fail('彻底删除', j)
            })
            .catch(function (e) { fail('彻底删除', { error: String(e) }) })
            .finally(function () { setBusy(false) })
        }, [reload])

        var purgeAll = react.useCallback(function () {
          var pending = (entries || []).filter(function (e) { return e.action === 'delete' && e.restoreStatus === 'pending' }).length
          if (!pending) { window.alert('没有可彻底删除的待恢复记录。'); return }
          if (!window.confirm(
            '彻底删除全部 ' + pending + ' 条待恢复记录的回收站文件？\n\n' +
            '这些会话的本地文件将从磁盘永久清除，之后无法再恢复！\n' +
            '（只清理会话管理插件自己登记的条目，回收站根目录下其他来源的文件一律不动）'
          )) return
          setBusy(true)
          fetch('/session-manager/history/purge-all', { method: 'POST' })
            .then(function (r) { return r.json() })
            .then(function (j) {
              if (j && j.ok) { window.alert('已彻底删除 ' + (j.purged || 0) + ' 条记录（' + (j.removedFiles || 0) + ' 个文件，释放 ' + fmtBytes(j.removedBytes) + '）。'); reload() }
              else fail('彻底删除', j)
            })
            .catch(function (e) { fail('彻底删除', { error: String(e) }) })
            .finally(function () { setBusy(false) })
        }, [entries, reload])

        var shown = (entries || []).filter(function (e) {
          if (filter === 'delete') return e.action === 'delete'
          if (filter === 'move') return e.action === 'move'
          return true
        })
        var delCount = (entries || []).filter(function (e) { return e.action === 'delete' }).length
        var moveCount = (entries || []).filter(function (e) { return e.action === 'move' }).length
        var restorable = (entries || []).filter(function (e) { return e.action === 'delete' && e.restoreStatus === 'pending' }).length

        return el('div', { className: 'sm-root' },
          el('style', null, CSS),
          el('div', { className: 'sm-head' },
            el('span', { className: 'sm-title' }, '会话管理'),
            el('span', { className: 'sm-spacer' }),
            el('button', { className: 'sm-btn', onClick: reload, disabled: busy }, busy ? '加载中…' : '刷新'),
            el('button', { className: 'sm-btn danger', onClick: purgeAll, disabled: busy || !entries || !restorable }, '清空回收站'),
            el('button', { className: 'sm-btn danger', onClick: clearAll, disabled: busy || !entries || !entries.length }, '清空日志')
          ),
          el('div', { className: 'sm-sub' }, '删除 / 移动操作的审计日志；删除的物理文件保存在回收站，可一键恢复或彻底删除。'),
          el('div', { className: 'sm-stats' },
            el('div', { className: 'sm-stat' }, el('b', null, entries ? entries.length : '—'), el('span', null, '总记录')),
            el('div', { className: 'sm-stat' }, el('b', null, entries ? delCount : '—'), el('span', null, '删除')),
            el('div', { className: 'sm-stat' }, el('b', null, entries ? moveCount : '—'), el('span', null, '移动')),
            el('div', { className: 'sm-stat' }, el('b', null, entries ? restorable : '—'), el('span', null, '可恢复'))
          ),
          el('div', null,
            el('div', { className: 'sm-tabs' },
              [['all', '全部'], ['delete', '删除'], ['move', '移动']].map(function (t) {
                return el('button', {
                  key: t[0],
                  className: 'sm-tab' + (filter === t[0] ? ' active' : ''),
                  onClick: function () { setFilter(t[0]) },
                }, t[1])
              })
            )
          ),
          err ? el('div', { className: 'sm-badge err', style: { marginBottom: 10, display: 'inline-block' } }, '加载失败：' + err) : null,
          entries === null
            ? el('div', { className: 'sm-empty' }, '正在加载操作日志…')
            : shown.length === 0
              ? el('div', { className: 'sm-table-wrap' }, el('div', { className: 'sm-empty' }, filter === 'all' ? '暂无操作记录。删除或移动会话后会出现在这里。' : '该分类下暂无记录。'))
              : el('div', { className: 'sm-table-wrap' },
                  el('table', { className: 'sm-table' },
                    el('thead', null, el('tr', null, cols.map(function (c, i) {
                      return el('th', {
                        key: c.key,
                        draggable: true,
                        style: { width: c.width + 'px' },
                        title: '拖动换位 · 拖右边缘调宽',
                        onDragStart: onThDragStart(i),
                        onDragOver: onThDragOver,
                        onDrop: onThDrop(i),
                        onDragEnd: function () { dragFrom.current = -1 },
                      },
                        c.label,
                        el('span', { className: 'sm-col-resizer', onMouseDown: startResize(c.key), draggable: false })
                      )
                    }))),
                    el('tbody', null, shown.map(function (e) {
                      var isDel = e.action === 'delete'
                      var cells = {}
                      cells.time = el('td', { className: 'sm-mono sm-muted' }, fmtTime(e.at))
                      cells.action = el('td', null,
                        el('span', { className: 'sm-act' },
                          el('span', { className: 'dot ' + (isDel ? 'sm-dot-del' : 'sm-dot-move') }),
                          isDel ? '删除' : '移动'
                        )
                      )
                      var t = titles[e.sessionId]
                      var label = (t && t.title) || e.sessionTitle || (e.sessionId || '').slice(0, 20) || '（未知会话）'
                      var tip = (t && t.title) || label
                      if (t && t.source === 'trash') tip += '（当前命名取自回收站日志）'
                      cells.session = el('td', null,
                        el('div', { className: 'sm-title-cell sm-session-title', title: tip }, label),
                        el('div', { className: 'sm-mono sm-muted' }, (e.sessionId || '').slice(0, 26) + '…')
                      )
                      cells.workspace = el('td', null, isDel
                        ? (e.workspaceTitle || e.workspaceId || '—')
                        : ((e.fromWorkspaceTitle || e.fromWorkspaceId || '—') + ' → ' + (e.toWorkspaceTitle || e.toWorkspaceId || '—')))
                      cells.content = el('td', { className: 'sm-muted' }, isDel
                        ? (fmtBytes(e.bytes) + (e.files && e.files.length ? ' · ' + e.files.length + ' 项入回收站' : ' · 无物理文件'))
                        : (e.movedDir ? '目录已迁移' : '仅改索引') + (e.extraCopiesRemoved ? ' · 清理多余副本 ×' + e.extraCopiesRemoved : ''))
                      var statusCell
                      if (!isDel) statusCell = el('span', { className: 'sm-badge ok' }, '已完成')
                      else if (e.restoreStatus === 'restored') statusCell = el('span', { className: 'sm-badge ok' }, '已恢复')
                      else if (e.restoreStatus === 'purged') statusCell = el('span', { className: 'sm-badge err' }, '已彻底删除')
                      else if (e.restoreStatus === 'pending') {
                        statusCell = el('div', { className: 'sm-status-cell' },
                          el('button', { className: 'sm-restore', onClick: function () { restore(e) }, disabled: busy }, '↩ 恢复'),
                          el('button', { className: 'sm-purge', onClick: function () { purgeOne(e) }, disabled: busy, title: '永久删除该记录的回收站文件，不可恢复' }, '彻底删除')
                        )
                      } else statusCell = el('span', { className: 'sm-badge pend' }, e.restoreStatus || '—')
                      cells.status = el('td', null, statusCell)
                      return el('tr', { key: e.id }, cols.map(function (c) { return cells[c.key] || el('td', null, '—') }))
                    }))
                  )
                )
        )
      }

      const module = { exports: {} }
      module.exports = { name: PLUGIN_ID, inject, apply }
      return module.exports
    },
  })
})()
