/**
 * dsh-session-manager / core
 *
 * 纯文件系统实现：会话删除（含本地资源）与跨工作区移动。
 * 不依赖 DSH 运行时内部服务状态，因此 CLI 与 Host 插件可以共用同一份逻辑。
 *
 * 真源：
 *   <DSH_HOME>/storages/workspace.json      工作区注册、sessionIds、archive/pin
 *   <DSH_HOME>/sessions/<projectKey>/<encodedId>/session.v4.jsonl.zstd
 *   <DSH_HOME>/storages/session_projcache/  可选派生物理缓存
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'

const ZSTD_MAGIC = 4247762216
const CHECKSUM_OPTIONS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } }

// ---------------------------------------------------------------- paths

export function dshHome() {
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return fromEnv !== '' ? fromEnv : path.join(os.homedir(), '.dsh')
}

export const sessionsRoot = () => path.join(dshHome(), 'sessions')
export const workspaceFile = () => path.join(dshHome(), 'storages', 'workspace.json')
export const projcacheDir = () => path.join(dshHome(), 'storages', 'session_projcache')

// ---------------------------------------------------------------- history & trash
// 操作历史（删除/移动审计日志）与回收站（删除的物理文件可一键恢复）。
// 历史文件：<DSH_HOME>/storages/session-manager-history.json（新条目在前，上限 500 条）
// 回收站：<DSH_HOME>/storages/session-manager-trash/<entryId>/{files|projcache}/…

export const historyFile = () => path.join(dshHome(), 'storages', 'session-manager-history.json')
export const trashRoot = () => path.join(dshHome(), 'storages', 'session-manager-trash')

function loadHistory() {
  try {
    const arr = JSON.parse(fs.readFileSync(historyFile(), 'utf8'))
    return Array.isArray(arr) ? arr : []
  } catch { return [] }
}

function saveHistory(list) {
  fs.mkdirSync(path.dirname(historyFile()), { recursive: true })
  fs.writeFileSync(historyFile(), JSON.stringify(list, null, 2), 'utf8')
}

let historySeq = 0
function recordHistory(entry) {
  const list = loadHistory()
  const full = { id: `${Date.now().toString(36)}-${(historySeq++).toString(36)}`, at: new Date().toISOString(), ...entry }
  list.unshift(full)
  if (list.length > 500) list.length = 500
  saveHistory(list)
  return full
}

export function listHistory({ limit = 200, action } = {}) {
  let list = loadHistory()
  if (action) list = list.filter(e => e.action === action)
  return list.slice(0, Math.max(1, Math.min(Number(limit) || 200, 1000)))
}

export function clearHistory() {
  saveHistory([])
  return { ok: true, cleared: true }
}

/** 把文件/目录移入回收站条目目录，返回移动记录。 */
function trashInto(entryId, srcAbs, kind) {
  const destDir = path.join(trashRoot(), entryId, kind)
  fs.mkdirSync(destDir, { recursive: true })
  const ext = path.extname(srcAbs)
  const base = path.basename(srcAbs, ext)
  let dest = path.join(destDir, path.basename(srcAbs))
  if (fs.existsSync(dest)) dest = path.join(destDir, `${base}_${Date.now().toString(36)}${ext}`)
  try { fs.renameSync(srcAbs, dest) } catch {
    fs.cpSync(srcAbs, dest, { recursive: true })
    fs.rmSync(srcAbs, { recursive: true, force: true })
  }
  let bytes = 0
  try { bytes = fs.statSync(dest).size } catch {}
  return { from: srcAbs, to: dest, kind, bytes }
}

/** 从回收站恢复一条删除记录：物理文件回原位 + 重新挂回工作区成员/归档/置顶。 */
export function restoreHistoryEntry(entryId) {
  const list = loadHistory()
  const e = list.find(x => x && x.id === entryId)
  if (!e) throw new Error(`history entry not found: ${entryId}`)
  if (e.action !== 'delete') throw new Error('只有删除记录支持恢复')
  if (e.restoreStatus === 'restored') throw new Error('该记录已恢复过')
  if (e.restoreStatus === 'purged') throw new Error('该记录已彻底删除，回收站文件已不存在，无法恢复')

  const moved = []
  for (const f of e.files || []) {
    if (!f || !f.from || !f.to) continue
    if (!fs.existsSync(f.to)) continue // 回收站文件已不在，跳过
    fs.mkdirSync(path.dirname(f.from), { recursive: true })
    if (fs.existsSync(f.from)) continue // 原位已被占用，跳过避免覆盖
    try { fs.renameSync(f.to, f.from) } catch {
      fs.cpSync(f.to, f.from, { recursive: true })
      fs.rmSync(f.to, { recursive: true, force: true })
    }
    moved.push(f.from)
  }

  const store = readWorkspaceStore()
  const w = store.tables.workspaces[e.workspaceId]
  if (w && Array.isArray(w.sessionIds) && !w.sessionIds.includes(e.sessionId)) {
    w.sessionIds = [e.sessionId, ...w.sessionIds]
    w.updatedAt = new Date().toISOString()
  }
  if (e.archived && Array.isArray(store.global.archivedSessionIds) && !store.global.archivedSessionIds.includes(e.sessionId)) {
    store.global.archivedSessionIds.push(e.sessionId)
  }
  if (e.pinned && Array.isArray(store.global.pinnedSessionIds) && !store.global.pinnedSessionIds.includes(e.sessionId)) {
    store.global.pinnedSessionIds.push(e.sessionId)
  }
  writeWorkspaceStore(store)

  try { fs.rmSync(e.trashEntry, { recursive: true, force: true }) } catch {}
  e.restoreStatus = 'restored'
  e.restoredAt = new Date().toISOString()
  saveHistory(list)
  return { ok: true, sessionId: e.sessionId, restoredFiles: moved.length, moved }
}

/** 删除单条记录登记在回收站中的物理文件（只动它自己的 trashEntry 与 files 列表，绝不触碰回收站根下其他内容）。 */
function purgeEntryFiles(e) {
  let removedFiles = 0
  let removedBytes = 0
  // 逐个删除 files 里登记的回收站路径（真实删除的权威清单）
  for (const f of e.files || []) {
    if (!f || !f.to) continue
    try {
      const st = fs.statSync(f.to)
      fs.rmSync(f.to, { recursive: true, force: true })
      removedFiles++
      removedBytes += typeof st.size === 'number' ? st.size : 0
    } catch { /* 已不存在，跳过 */ }
  }
  // 再清该条目自己的目录壳
  if (typeof e.trashEntry === 'string' && e.trashEntry.startsWith(trashRoot())) {
    try { fs.rmSync(e.trashEntry, { recursive: true, force: true }) } catch {}
  }
  return { removedFiles, removedBytes }
}

/** 彻底删除一条记录的回收站文件（不可恢复），记录保留但标记为 purged。 */
export function purgeHistoryEntry(entryId) {
  const list = loadHistory()
  const e = list.find(x => x && x.id === entryId)
  if (!e) throw new Error(`history entry not found: ${entryId}`)
  if (e.action !== 'delete') throw new Error('只有删除记录包含回收站文件')
  if (e.restoreStatus === 'purged') throw new Error('该记录已彻底删除过')
  const { removedFiles, removedBytes } = purgeEntryFiles(e)
  e.restoreStatus = 'purged'
  e.purgedAt = new Date().toISOString()
  saveHistory(list)
  return { ok: true, entryId, sessionId: e.sessionId, removedFiles, removedBytes }
}

/** 彻底清空所有「待恢复」删除记录的回收站文件。
 *  只逐条处理历史中登记的条目目录，不做整目录清空——回收站根下不属于本插件记录的文件一律不碰。 */
export function purgeAllHistoryEntries() {
  const list = loadHistory()
  let purged = 0
  let removedFiles = 0
  let removedBytes = 0
  let skipped = 0
  for (const e of list) {
    if (!e || e.action !== 'delete') continue
    if (e.restoreStatus !== 'pending') { skipped++; continue }
    const r = purgeEntryFiles(e)
    e.restoreStatus = 'purged'
    e.purgedAt = new Date().toISOString()
    purged++
    removedFiles += r.removedFiles
    removedBytes += r.removedBytes
  }
  if (purged > 0) saveHistory(list)
  return { ok: true, purged, skipped, removedFiles, removedBytes }
}

// ---------------------------------------------------------------- session titles

/** 从单个会话日志文件提取首条用户消息文本（即侧栏显示的「当前命名」）。
 *  zstd 多帧日志按帧顺序解压，找到即停，避免整文件解压。 */
function firstUserTextFromFile(file) {
  let buf
  try { buf = fs.readFileSync(file) } catch { return null }
  const linesOf = (text) => text.split('\n').filter(Boolean)
  let texts = null
  try {
    if (buf.length >= 4 && buf.readUInt32LE(0) === ZSTD_MAGIC) {
      const frames = scanFrames(buf)
      for (const f of frames) {
        let chunk
        try { chunk = zlib.zstdDecompressSync(buf.subarray(f.start, f.end)).toString('utf8') } catch { continue }
        const found = findUserText(linesOf(chunk))
        if (found) { texts = found; break }
      }
    } else {
      texts = findUserText(linesOf(buf.toString('utf8')))
    }
  } catch { return null }
  return texts
}

function findUserText(lines) {
  for (const line of lines) {
    if (!line.includes('agent/inbox/spliced') && !line.includes('"role":"user"')) continue
    let j
    try { j = JSON.parse(line) } catch { continue }
    if (j.type === 'agent/inbox/spliced' && j.data && Array.isArray(j.data.inserted)) {
      for (const item of j.data.inserted) {
        if (item?.role !== 'user' || !Array.isArray(item.content)) continue
        const text = item.content.filter(c => c && typeof c.text === 'string').map(c => c.text).join(' ').trim()
        if (text) return text
      }
    }
  }
  return null
}

/** 批量获取会话的「当前命名」：优先读在线日志首条用户消息；已删除的从回收站日志读；都没有则回退 null。 */
export function sessionCurrentTitles(sessionIds) {
  const ids = Array.isArray(sessionIds) ? sessionIds.filter(s => typeof s === 'string') : []
  if (!ids.length) return {}
  const byId = new Map()
  for (const s of scanSessionFiles()) {
    if (!byId.has(s.id)) byId.set(s.id, s.file)
  }
  // 已删除的会话：从审计日志里找它登记的回收站日志文件
  const history = loadHistory()
  const trashLogOf = new Map()
  for (const e of history) {
    if (!e || e.action !== 'delete' || !e.sessionId) continue
    if (trashLogOf.has(e.sessionId)) continue
    for (const f of e.files || []) {
      if (!f || !f.to || !fs.existsSync(f.to)) continue
      let logFile = f.to
      const st = fs.statSync(f.to)
      if (st.isDirectory()) {
        // files[].to 记录的是会话目录，日志文件在其内部
        const logs = sessionLogFiles(f.to)
        if (logs.length) logFile = logs[0]
        else continue
      } else if (!/session\.v\d+\.jsonl(\.zstd)?$/.test(f.to)) {
        continue
      }
      trashLogOf.set(e.sessionId, logFile)
      break
    }
  }
  const out = {}
  for (const id of ids) {
    const live = byId.get(id)
    const text = live ? firstUserTextFromFile(live) : null
    const trashed = text ? null : firstUserTextFromFile(trashLogOf.get(id) || '')
    const raw = text || trashed || null
    out[id] = {
      title: raw ? raw.replace(/\s+/g, ' ').slice(0, 80) : null,
      truncated: raw ? raw.length > 80 : false,
      source: text ? 'live' : (trashed ? 'trash' : null),
    }
  }
  return out
}

// ---------------------------------------------------------------- encoding
// 与 dsh-session-persistence-jsonl 中的 encodeSegment/projectKey 逐字一致。

function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

function sessionDir(root, cwd, id) {
  return path.join(root, cwd === undefined ? '_no-cwd' : projectKey(cwd), encodeSegment(id))
}

// ---------------------------------------------------------------- zstd frames

/** 按 zstd spec 扫描文件中每个独立帧的 [start,end) 边界。 */
export function scanFrames(buf) {
  const frames = []
  let off = 0
  while (off < buf.length) {
    const start = off
    if (buf.length - off < 4) throw new Error(`zstd: truncated frame magic at ${off}`)
    if (buf.readUInt32LE(off) !== ZSTD_MAGIC) throw new Error(`zstd: bad magic at ${off}`)
    off += 4
    const d = buf.readUInt8(off++)
    if (d & 0x18) throw new Error(`zstd: reserved frame-header bits at ${start}`)
    const single = !!(d & 0x20)
    const checksum = !!(d & 0x4)
    const dictFlag = d & 3
    const csf = d >>> 6
    const dictBytes = dictFlag === 3 ? 4 : dictFlag
    const csBytes = csf === 0 ? (single ? 1 : 0) : (1 << csf)
    off += (single ? 0 : 1) + dictBytes + csBytes
    for (;;) {
      const h = buf.readUIntLE(off, 3)
      off += 3
      const last = !!(h & 1)
      const type = (h >>> 1) & 3
      const size = h >>> 3
      if (type === 3) throw new Error(`zstd: reserved block type at ${start}`)
      off += type === 1 ? 1 : size
      if (last) break
    }
    if (checksum) off += 4
    if (off > buf.length) throw new Error(`zstd: frame overruns file at ${start}`)
    frames.push({ start, end: off })
  }
  return frames
}

function sessionLogFiles(dir) {
  try {
    return fs.readdirSync(dir)
      .filter(n => n === 'session.jsonl' || /^session\.v\d+\.jsonl(\.zstd)?$/.test(n) || n === 'session.jsonl.zstd')
      .sort((a, b) => {
        const va = /v(\d+)/.exec(a)
        const vb = /v(\d+)/.exec(b)
        return (vb ? +vb[1] : 0) - (va ? +va[1] : 0)
      })
      .map(n => path.join(dir, n))
  } catch {
    return []
  }
}

/** 读会话日志首行的物理 header（不依赖 catalog encode/decode）。 */
export function readSessionHeader(file) {
  const buf = fs.readFileSync(file)
  const frames = file.endsWith('.zstd') ? scanFrames(buf) : null
  let first
  if (frames) {
    if (!frames.length) throw new Error(`no zstd frames in ${file}`)
    first = zlib.zstdDecompressSync(buf.subarray(frames[0].start, frames[0].end))
  } else {
    const nl = buf.indexOf(0x0a)
    first = nl < 0 ? buf : buf.subarray(0, nl)
  }
  const text = first.toString('utf8')
  const nl = text.indexOf('\n')
  const line = nl >= 0 ? text.slice(0, nl) : text
  const header = JSON.parse(line)
  if (header?.type !== 'session' || typeof header.id !== 'string') {
    throw new Error(`not a session header: ${file}`)
  }
  return { header, headerLine: line, rest: nl >= 0 ? text.slice(nl + 1) : '', raw: buf, frames }
}

function rewriteHeaderFile(file, mutate) {
  const { header, rest, raw, frames } = readSessionHeader(file)
  const next = { ...header }
  mutate(next, header)
  const plain = Buffer.from(JSON.stringify(next) + (rest !== '' ? '\n' + rest : ''), 'utf8')
  if (!frames) {
    fs.writeFileSync(file, plain)
    return { file, frames: 0 }
  }
  const rebuilt = zlib.zstdCompressSync(plain, CHECKSUM_OPTIONS)
  const out = Buffer.concat([rebuilt, raw.subarray(frames[1].start)])
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, out)
  fs.renameSync(tmp, file)
  return { file, frames: frames.length }
}

// ---------------------------------------------------------------- workspace store

export function readWorkspaceStore() {
  const file = workspaceFile()
  const raw = fs.readFileSync(file, 'utf8')
  const store = JSON.parse(raw)
  if (!store?.unit || store.unit.name !== 'workspace' || !store?.tables?.workspaces || !store?.global) {
    throw new Error(`unexpected workspace store shape: ${file}`)
  }
  return store
}

function writeWorkspaceStore(store, { backup = true } = {}) {
  const file = workspaceFile()
  if (backup) {
    const bak = `${file}.bak.${new Date().toISOString().replace(/[:.]/g, '-')}`
    fs.copyFileSync(file, bak)
  }
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, file)
  return file
}

function workspaceOf(store, sessionId) {
  return Object.entries(store.tables.workspaces)
    .find(([, w]) => Array.isArray(w.sessionIds) && w.sessionIds.includes(sessionId)) || null
}

// ---------------------------------------------------------------- discovery

function scanSessionFiles() {
  const root = sessionsRoot()
  const out = []
  if (!fs.existsSync(root)) return out
  let projects = []
  try { projects = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()) } catch { return out }
  for (const pe of projects) {
    const pdir = path.join(root, pe.name)
    let sessions = []
    try { sessions = fs.readdirSync(pdir, { withFileTypes: true }).filter(e => e.isDirectory()) } catch { continue }
    for (const se of sessions) {
      const dir = path.join(pdir, se.name)
      const files = sessionLogFiles(dir)
      if (!files.length) continue
      let id = se.name
      let cwd
      let header = null
      try {
        const h = readSessionHeader(files[0])
        id = h.header.id
        cwd = h.header.cwd
        header = h.header
      } catch {
        // 头部损坏也保留条目，允许按目录名定位后删除
      }
      out.push({ id, dir, projectDir: pdir, file: files[0], files, cwd, header })
    }
  }
  return out
}

export function listWorkspaces() {
  const store = readWorkspaceStore()
  return store.global.workspaceIds.map(id => {
    const w = store.tables.workspaces[id]
    return w ? { id, title: w.title, path: w.path, sessionCount: (w.sessionIds || []).length, createdAt: w.createdAt, updatedAt: w.updatedAt } : { id, missing: true }
  })
}

export function listSessions({ workspaceId, search, includeArchived = true } = {}) {
  const store = readWorkspaceStore()
  const archived = new Set(store.global.archivedSessionIds || [])
  const pinned = new Set(store.global.pinnedSessionIds || [])
  const needle = typeof search === 'string' && search.trim() !== '' ? search.trim().toLowerCase() : ''
  const rows = []
  const seen = new Set()
  for (const s of scanSessionFiles()) {
    const key = s.id
    const first = !seen.has(key)
    if (first) seen.add(key)
    const owner = workspaceOf(store, s.id)
    if (workspaceId && (!owner || owner[0] !== workspaceId)) continue
    if (needle) {
      const hay = `${s.id} ${s.header?.agentPreset || ''} ${owner?.[1]?.title || ''} ${s.cwd || ''}`.toLowerCase()
      if (!hay.includes(needle)) continue
    }
    const row = {
      id: s.id,
      workspaceId: owner?.[0] ?? null,
      workspaceTitle: owner?.[1]?.title ?? null,
      cwd: s.cwd ?? null,
      agentPreset: s.header?.agentPreset ?? null,
      createdAt: s.header?.createdAt ?? null,
      archived: archived.has(s.id),
      pinned: pinned.has(s.id),
      file: s.file,
      bytes: fs.statSync(s.file).size,
      physicalCopies: first ? 1 : undefined,
    }
    if (!includeArchived && row.archived) continue
    rows.push(row)
  }
  rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  return rows
}

// ---------------------------------------------------------------- operations

function resolveSession(sessionId) {
  const all = scanSessionFiles().filter(s => s.id === sessionId)
  if (!all.length) throw new Error(`session not found: ${sessionId}`)
  return all
}

function projcacheTargets(sessionId) {
  const uuid = sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : sessionId
  const dir = projcacheDir()
  const names = new Set([sessionId, uuid].map(n => `${n}.json`))
  const out = []
  // 递归扫描：缓存文件可能位于 sessions/ 等子目录（2026-11-26 修复，原先只查顶层导致清理遗漏）
  const walk = (d) => {
    let entries
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (names.has(e.name)) out.push(p)
    }
  }
  walk(dir)
  return out
}

export function deleteSession({ sessionId, cleanProjcache = true, dryRun = false } = {}) {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') throw new Error('sessionId is required')
  sessionId = sessionId.trim()
  const copies = resolveSession(sessionId)
  const store = readWorkspaceStore()
  const owner = workspaceOf(store, sessionId)
  const archivedBefore = (store.global.archivedSessionIds || []).includes(sessionId)
  const pinnedBefore = (store.global.pinnedSessionIds || []).includes(sessionId)
  const caches = cleanProjcache ? projcacheTargets(sessionId) : []
  const bytes = copies.reduce((n, s) => n + fs.statSync(s.file).size, 0)

  if (!dryRun) {
    const entryId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const trashed = []
    // 物理会话目录 → 回收站（可恢复），不再直接删除
    for (const s of copies) trashed.push(trashInto(entryId, s.dir, 'files'))
    // 若某 projectDir 已空，顺手移除，避免留下空壳目录
    for (const pdir of new Set(copies.map(s => s.projectDir))) {
      try { if (fs.readdirSync(pdir).length === 0) fs.rmdirSync(pdir) } catch {}
    }
    for (const c of caches) trashed.push(trashInto(entryId, c, 'projcache'))
    for (const [, w] of Object.entries(store.tables.workspaces)) {
      if (Array.isArray(w.sessionIds)) w.sessionIds = w.sessionIds.filter(id => id !== sessionId)
      w.updatedAt = new Date().toISOString()  // 宿主 schema 要求 ISO 字符串，禁止写数字时间戳（2026-11-26 修复）
    }
    store.global.archivedSessionIds = (store.global.archivedSessionIds || []).filter(id => id !== sessionId)
    store.global.pinnedSessionIds = (store.global.pinnedSessionIds || []).filter(id => id !== sessionId)
    writeWorkspaceStore(store)

    recordHistory({
      action: 'delete',
      sessionId,
      sessionTitle: copies[0]?.header?.title ?? copies[0]?.header?.agentPreset ?? null,
      cwd: copies[0]?.cwd ?? null,
      workspaceId: owner?.[0] ?? null,
      workspaceTitle: owner?.[1]?.title ?? null,
      bytes,
      files: trashed,
      archived: archivedBefore,
      pinned: pinnedBefore,
      trashEntry: path.join(trashRoot(), entryId),
      restoreStatus: 'pending',
    })
  }

  return {
    ok: true,
    action: 'delete_session',
    sessionId,
    dryRun,
    workspaceId: owner?.[0] ?? null,
    removedPhysicalCopies: copies.map(s => s.dir),
    removedBytes: bytes,
    removedProjcache: caches,
    removedFromArchive: archivedBefore,
    removedFromPinned: pinnedBefore,
    note: 'attachments 为内容寻址（<DSH_HOME>/attachments/v1/objects），无法按会话精确归属，默认不清理。',
  }
}

export function moveSession({ sessionId, workspaceId, dryRun = false, allowMissingTargetDir = false } = {}) {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') throw new Error('sessionId is required')
  if (typeof workspaceId !== 'string' || workspaceId.trim() === '') throw new Error('workspaceId is required')
  sessionId = sessionId.trim()
  workspaceId = workspaceId.trim()

  const store = readWorkspaceStore()
  const target = store.tables.workspaces[workspaceId]
  if (!target) throw new Error(`workspace not found: ${workspaceId}`)
  if (typeof target.path !== 'string' || target.path === '') throw new Error(`workspace '${workspaceId}' has no path`)
  if (!allowMissingTargetDir && !fs.existsSync(target.path)) {
    throw new Error(`target workspace directory does not exist: ${target.path} (pass allowMissingTargetDir:true to force)`)
  }

  const copies = resolveSession(sessionId)
  const source = copies[0]
  const owner = workspaceOf(store, sessionId)
  if (owner && owner[0] === workspaceId && source.cwd === target.path) {
    return { ok: true, action: 'move_session', sessionId, workspaceId, dryRun, changed: false, note: '会话已在该工作区。' }
  }

  const oldCwd = source.cwd
  const oldDir = source.dir
  const newDir = sessionDir(sessionsRoot(), target.path, sessionId)
  const newFile = path.join(newDir, path.basename(source.file))
  const needsHeaderRewrite = oldCwd !== target.path
  const needsPhysicalMove = path.normalize(oldDir) !== path.normalize(newDir)

  if (!dryRun) {
    // 1) 先改物理日志的 header.cwd（只重建首帧，其余帧原样拼接）
    if (needsHeaderRewrite) rewriteHeaderFile(source.file, h => { h.cwd = target.path })

    // 2) 移动/重命名目录（跨 projectDir）
    if (needsPhysicalMove) {
      fs.mkdirSync(path.dirname(newDir), { recursive: true })
      if (fs.existsSync(newDir)) throw new Error(`target session dir already exists: ${newDir}`)
      fs.renameSync(oldDir, newDir)
      try { const p = path.dirname(oldDir); if (fs.readdirSync(p).length === 0) fs.rmdirSync(p) } catch {}
      // 多份物理副本：删除其余副本，保留已移动的主副本
      for (const extra of copies.slice(1)) fs.rmSync(extra.dir, { recursive: true, force: true })
    } else {
      for (const extra of copies.slice(1)) fs.rmSync(extra.dir, { recursive: true, force: true })
    }

    // 3) 更新 workspace.json 成员关系
    const isoNow = new Date().toISOString()  // 宿主 schema 要求 ISO 字符串（2026-11-26 修复）
    for (const [, w] of Object.entries(store.tables.workspaces)) {
      if (Array.isArray(w.sessionIds)) w.sessionIds = w.sessionIds.filter(id => id !== sessionId)
      w.updatedAt = isoNow
    }
    target.sessionIds = [sessionId, ...(Array.isArray(target.sessionIds) ? target.sessionIds : [])]
    target.updatedAt = isoNow
    writeWorkspaceStore(store)

    recordHistory({
      action: 'move',
      sessionId,
      sessionTitle: source?.header?.title ?? source?.header?.agentPreset ?? null,
      fromWorkspaceId: owner?.[0] ?? null,
      fromWorkspaceTitle: owner?.[1]?.title ?? null,
      toWorkspaceId: workspaceId,
      toWorkspaceTitle: target.title,
      oldCwd: oldCwd ?? null,
      newCwd: target.path,
      movedDir: needsPhysicalMove,
      extraCopiesRemoved: Math.max(0, copies.length - 1),
    })
  }

  return {
    ok: true,
    action: 'move_session',
    sessionId,
    workspaceId,
    workspaceTitle: target.title,
    dryRun,
    changed: true,
    oldCwd: oldCwd ?? null,
    newCwd: target.path,
    oldDir,
    newDir: needsPhysicalMove ? newDir : oldDir,
    newFile: needsPhysicalMove ? newFile : source.file,
    headerRewritten: needsHeaderRewrite,
    note: '运行中 DSH 的内存索引可能仍持有旧 cwd；若侧栏未立即刷新，切换一次工作区或重启 DSH。',
  }
}

// ---------------------------------------------------------------- tool facade

export function dispatch(action, args = {}) {
  switch (action) {
    case 'list_workspaces': return listWorkspaces()
    case 'list_sessions': return listSessions(args)
    case 'delete_session': return deleteSession(args)
    case 'move_session': return moveSession(args)
    case 'list_history': return listHistory(args)
    case 'clear_history': return clearHistory()
    case 'restore_history': return restoreHistoryEntry(args?.entryId)
    case 'purge_history': return purgeHistoryEntry(args?.entryId)
    case 'purge_all_history': return purgeAllHistoryEntries()
    case 'session_titles': return sessionCurrentTitles(args?.sessionIds)
    default: throw new Error(`unknown action: ${action} (expected list_workspaces|list_sessions|delete_session|move_session|list_history|clear_history|restore_history|purge_history|purge_all_history|session_titles)`)
  }
}

export const ACTIONS = ['list_workspaces', 'list_sessions', 'delete_session', 'move_session', 'list_history', 'clear_history', 'restore_history', 'purge_history', 'purge_all_history', 'session_titles']
