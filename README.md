# dsh-session-manager

DeepSeek Harness（DSH）会话管理插件 —— 为 DSH 补上原生 UI 缺失的**会话真删除**、**回收站 + 误删恢复**、**跨工作区移动**三项能力，附带审计日志与专业的左侧栏管理面板。

## 插件用途

DSH 自带 UI 只能「归档」会话，无法真正删除，也不能跨工作区移动。调研结论（DSH `0.2.2-rc.1`）：

- `WorkspaceCommands` 只有 `create/rename/delete/insertBefore/insertSessionBefore/archiveSession/unarchiveSession/pinSession/unpinSession`；没有删除会话、跨工作区移动会话的 Remote 命令。
- `dsh-session-persistence-jsonl` 明确不删除会话文件（"日志在 root 下累积，直到外部移除"）。
- 底层 `WorkspaceEntity.attachSession` 要求 `header.cwd === workspace.path`，直接跨工作区移动会被过滤掉。

因此本插件采用**纯文件系统方案**：直接读写 `<DSH_HOME>/storages/workspace.json`、`<DSH_HOME>/sessions/`、`<DSH_HOME>/storages/session_projcache/`，用 `node:zlib` 原生 zstd 的多帧能力只重建会话日志首帧（改写 cwd），其余帧字节原样拼接。不依赖运行时内存状态，CLI 与 Host 插件共用同一份逻辑（`lib/core.js`）。

### 功能总览

| 能力 | 说明 |
|---|---|
| 🗑️ 删除会话 | 彻底删除会话：物理日志、`session_projcache` 缓存、workspace.json 中的成员/归档/置顶记录一次清干净 |
| ♻️ 回收站 | 删除的物理文件先移入插件回收站（`~/.dsh/storages/session-manager-trash/`），不直接销毁 |
| ↩️ 一键恢复 | 从回收站回滚物理文件到原位，并重新挂回工作区（含归档/置顶状态） |
| 🔥 彻底删除 | 单条记录永久清除，或一键清空回收站（只清插件登记的条目，绝不误碰回收站文件夹里的其他文件） |
| 📦 移动会话 | 把会话移动到任意工作区：改写会话头 `cwd`、迁移物理目录、更新工作区成员关系 |
| 📋 审计日志 | 所有删除/移动操作都有时间、会话、工作区、清理内容的完整记录（上限 500 条） |
| 🖥️ 管理面板 | 左侧栏专属面板：统计磁贴、分类筛选、逐条恢复/彻底删除、清空日志/回收站 |
| 🏷️ 当前命名 | 面板实时显示会话的当前命名（取自会话日志首条用户消息，改过名也同步）；已删除的会话从回收站日志读取 |
| 📐 可调表格 | 面板表头可拖动换位、拖拽边缘调整列宽，布局自动记忆 |
| ⚡ 自动重启 | 删除/移动成功后一键自动重启 DSH（优先 Electron 优雅 relaunch，失败自动强杀重拉）；面板头部常驻「重启 DeepSeek」兜底按钮 |

### 安全设计

- 删除动作先进回收站，可随时恢复；「彻底删除」需二次确认且不可逆
- 「清空回收站」只逐条处理插件自己登记的条目目录，不整目录清空——回收站根下其他来源的文件一律不碰
- 所有写 `workspace.json` 的操作均使用 ISO 字符串时间戳（宿主 schema 要求，**禁止数字时间戳**，数字会写坏宿主服务链导致工作区全空），并有自动 `.bak` 备份
- 会话日志改写采用「写临时文件 + 原子 rename」，不会留下半截文件
- 本地 HTTP 路由做同源校验，拒绝跨站请求
- 所有写操作支持 `dryRun: true` 预演，不落盘

## 安装

### 方式一：npm 依赖直连 GitHub（推荐）

编辑 `~/.dsh/profiles/desktop/package.json`，在 `dependencies` 中加入：

```json
{
  "dependencies": {
    "dsh-session-manager": "github:CH4KH0/dsh-session-manager"
  }
}
```

然后在 `dsh.profile.bundles` 数组中加入 `"dsh-session-manager"`，重启 DeepSeek Harness 即可。

### 方式二：git clone + 本地路径

```bash
git clone https://github.com/CH4KH0/dsh-session-manager.git
# 克隆到任意位置，例如 C:\Users\Administrator\.dsh\plugins\dsh-session-manager
```

`~/.dsh/profiles/desktop/package.json` 的 `dependencies` 中加入：

```json
"dsh-session-manager": "file:C:/Users/Administrator/.dsh/plugins/dsh-session-manager"
```

同样在 `dsh.profile.bundles` 加入 `"dsh-session-manager"`，重启 DSH。

### 方式三：让 DSH 自己安装本地目录

在 DSH 对话里直接使用 `plugin_manager` 工具：

```
action: install_bundle
target: <插件目录路径>
```

用 `list_plugins` 确认 `dsh-session-manager` 出现且 enabled。

> **注意**：客户端面板和宿主路由都是启动时加载的，必须**完全退出并重启 DeepSeek Harness**（结束全部 DeepSeek Harness 进程）才能生效。宿主 schema 校验 `workspace.json` 时间戳必须为 ISO 字符串，请勿使用 v1.1.0 之前的版本。

## 使用方法

### 1. 会话 "..." 菜单（图形界面，最直观）

重启 DSH 后，侧栏任意会话的 `...` 菜单里会多出两项：

- **删除会话（含本地文件）** —— 弹窗确认后执行：日志与缓存进回收站、索引同步清除。重启 DSH 后会话从列表消失。
- **移动到工作区…** —— 子菜单列出所有工作区，选择后自动改写会话头 `cwd`、迁移物理目录。若侧栏未立即刷新，切换一次工作区或重启 DSH。

### 2. 会话管理面板（左侧栏 📁 图标）

| 区域 | 功能 |
|---|---|
| 统计磁贴 | 总记录 / 删除 / 移动 / 可恢复 数量一览 |
| 页签 | 全部 / 删除 / 移动 筛选 |
| 每条删除记录 | `↩ 恢复`（回滚文件并重新挂回工作区）· `彻底删除`（永久清除该条回收站文件） |
| 顶栏按钮 | `刷新` · `清空回收站`（一键永久清除全部待恢复记录）· `清空日志`（仅清审计记录，不动回收站文件） |
| 状态徽标 | 待恢复（可恢复）· 已恢复 · 已彻底删除 · 已完成 |

### 3. Agent 工具 / CLI

插件注册 `session_manager` 工具，可在 DSH 对话中直接调用；也可脱离运行时用 CLI（`node lib/cli.js`，需 Node ≥ 22.8 且支持原生 `node:zlib` zstd）：

```
session_manager { action: "list_workspaces" }
session_manager { action: "list_sessions", workspaceId: "…", search: "关键词" }
session_manager { action: "delete_session", sessionId: "session-…", dryRun: true }   # 先预演
session_manager { action: "delete_session", sessionId: "session-…" }                 # 真删除
session_manager { action: "move_session",  sessionId: "session-…", workspaceId: "…" }
session_manager { action: "list_history" }
session_manager { action: "restore_history", entryId: "…" }   # 从回收站恢复
session_manager { action: "purge_history",   entryId: "…" }   # 单条彻底删除
session_manager { action: "purge_all_history" }               # 清空回收站
session_manager { action: "clear_history" }                   # 清空审计日志
```

CLI 示例：

```powershell
$node = 'Z:\Program Files\nodejs\node.exe'
$cli  = '<插件目录>\lib\cli.js'
& $node $cli list_workspaces
& $node $cli list_sessions --search 工具工程
& $node $cli delete_session --session-id session-1329ab39-... --dry-run
& $node $cli move_session --session-id session-b41a136b-... --workspace-id 90eb2f41-...
```

### 删除内容明细

- 物理会话目录（含 `session.v4.jsonl.zstd` 等全部日志版本）→ **移入插件回收站（可恢复）**
- 若所在 projectDir 变空，一并移除空目录
- `workspace.json` 里所有工作区的 `sessionIds` 中移除该 id，以及 `archivedSessionIds`、`pinnedSessionIds`
- `session_projcache` 中 `<id>.json` / `<uuid>.json` 派生缓存（默认清理，递归扫描子目录）
- 写入前对 `workspace.json` 做 `.bak.<时间戳>` 备份

附件是内容寻址（`attachments/v1/objects`），无法按会话精确归属，默认**不清理**（返回里会给出提示）。

### 移动执行内容

1. 改写会话日志首帧 header 的 `cwd` 为目标工作区 `path`（只重建首帧，其余帧字节不变）；
2. 物理会话目录迁移到目标 `projectKey` 下（多份物理副本时保留主副本、删除其余副本）；
3. 从旧工作区 `sessionIds` 移除，加入目标工作区 `sessionIds`；
4. 目标工作区目录不存在时默认拒绝；网络盘临时掉线可传 `allowMissingTargetDir:true` 强制。

## 数据位置

默认取 `$DSH_HOME`，未设置时为 `~/.dsh`：

| 用途 | 路径 |
| --- | --- |
| 插件回收站 | `<DSH_HOME>/storages/session-manager-trash/<entryId>/` |
| 审计日志 | `<DSH_HOME>/storages/session-manager-history.json` |
| 工作区注册真源 | `<DSH_HOME>/storages/workspace.json`（写前自动备份） |
| 会话日志 | `<DSH_HOME>/sessions/<projectKey>/<encodedId>/session.v4.jsonl.zstd` |
| 会话派生缓存 | `<DSH_HOME>/storages/session_projcache/` |
| 附件（默认不清理） | `<DSH_HOME>/attachments/v1/objects/` |

## 验证记录

- 2026-11-25（真实数据，85 会话 / 5 工作区）：`list_workspaces` / `list_sessions` / `delete_session --dry-run` / `move_session --dry-run` 全部字段正确；会话头改写实验（938827 字节、706 帧）帧数不变、其余帧字节逐一致、首帧可重新解压。
- 2026-11-26（v1.2.0）：删除→回收站→单条彻底删除→恢复拦截→双重 purge 拦截→回收站无关文件保护，端到端测试全部通过；生产环境实测删除链路（回收站文件、workspace.json ISO 时间戳、审计日志）逐项核对无误。

## 版本

- **v1.4.0** —— 删除/移动成功后**一键自动重启 DSH**（双层实现：Electron `app.relaunch()` 优雅重启 → 失败自动分离式助手强杀重拉）；面板头部新增「重启 DeepSeek」兜底按钮；新路由 `/session-manager/restart`
- **v1.3.1** —— 当前命名改读日志中**最后一个 `session/title` 事件**（手动更名/LLM 生成的标题都能同步）；面板新增 **5 秒自动刷新**（静默轮询，数据无变化不重渲染）
- **v1.3.0** —— 面板「会话」列显示会话**当前命名**；表头支持**拖动换位**与**拖拽调整列宽**，布局持久化到 localStorage
- **v1.2.0** —— 新增单条「彻底删除」与「清空回收站」；修复 purged 状态下的恢复拦截
- **v1.1.0** —— 回收站 + 审计日志 + 一键恢复 + 左侧栏管理面板；**修复 `workspace.json` 时间戳写数字导致宿主 workspaceController 瘫痪的问题**；projcache 清理改为递归扫描
- **v1.0.0** —— 首版：会话删除 / 跨工作区移动

## License

MIT
