# DEVELOPMENT.md — Host 侧契约（踩过的坑，改动前先看）

> 内部开发笔记，不随插件详情页发布。维护本插件前请先读完。

1. **不要导出 `Config = null`。** 设置服务对每个已挂载插件的 `Config`
   做 `'toJSON' in cfg` 检查，`null` 会抛
   `Cannot use 'in' operator to search for 'toJSON' in null`，导致
   `settings/describe` 失败 → 桌面端启动时 welcome RPC 失败 → 整个应用
   起不来。本插件因此不导出 `Config`（保留期固定 7 天）。
2. **模块级 `inject` 必须声明真实核心服务。** 本插件依赖
   `storageDomain`、`webServer`、`sessionPersistence`、`workspaceRegistry`
   四个宿主服务，全部要在 `export const inject = [...]` 里声明。
   这样 Cordis 会按依赖顺序激活插件 fiber，`ctx` 上才能直接拿到它们
   （`ctx.storageDomain` / `ctx.webServer` / `ctx.sessionPersistence` /
   `ctx.workspaceRegistry`）。这四个名字均已核对为其它核心插件使用的
   正式注入名。
3. **不要用 `inject = []` + 嵌套 `ctx.inject()` 的写法注册路由。**
   这套写法在无界面 CLI 宿主里能工作，但在 GUI 宿主里路由注册回调
   不会触发，导致 `/plugins/session-recycle/*` 全部 404（而 fiber 显示
   `active`、也没有任何启动报错）。改用模块级 inject + 直接注册后即修复。
   教训：注入服务用 `ctx.inject(deps, cb)`（**只接受两个参数**），但
   前提是这些服务在模块级 `inject` 里已声明，否则回调不可靠。
4. **路由注册的 try/catch 里引用了未声明的变量会被静默吞掉 → 全部 404。**
   曾经在 `registerRoutes()` 里用 `const route = (entry) => {
   disposers.push(webServer.register(entry)); }` 包 try/catch，但漏写了
   `const disposers = []`；每次注册都抛 `ReferenceError: disposers is not
   defined`，被 catch 吞掉，5 条路由一条也没注册，表现为
   `/plugins/session-recycle/*` 全是空 body 的 404（`node --check` 查不出，
   这是运行时错误）。改回显式声明 `const disposers = []` 后，用 mock ctx
   跑 `apply()` 验证 5 条路由全部注册成功。
5. **域表的 `valueSchema` 不能写 `null`。** `storageDomain.open()` 会对每条已存
   记录调用 `valueSchema.parse(raw)`（`dsh-storage-domain/lib/index.js:397`），
   `null` 不是 schema，遇到第一条真实记录就抛
   `DomainError: ... does not match its schema`，`start()` 中断 →
   `this.table` undefined → `/list` 返回 500
   `Cannot read properties of undefined (reading 'entries')`。
   隔离空库测不出来（没有记录可解析）。修复：用宽松的
   `const ANY_SCHEMA = { parse: (v) => v }`（记录是自有 JSON，无需校验）。
   已用真实存储文件（含 1 条记录）在隔离宿主复现并验证修复：
   `/list` 返回 200 且记录完整。
6. 启动失败必须用 `console.error` 打出来：`ctx.logger` 可能不存在，
   被 try/catch 吞掉的异常会让路由静默 404。排查期间还加了
   `diag()`（写 `~/.dsh/session-recycle-debug.log`），因为 GUI 宿主不采集
   `console.error`，这是唯一能落盘的启动里程碑。

## UI 侧扩展点备忘

- 会话右键菜单项：走**结构化** `ctx.contextMenus.register({
  id:'session-recycle.session.moveToTrash', target:'session', order:700,
  resolve: ({sessionId, displayTitle}) => [...] })`（order 700 位于内置
  pin100/rename200/fork300/copy450/archive600 之后）。图标通过
  `contextMenu.icon` keyed 插槽注册 14px/currentColor 字形。
  **不要**再用旧式 slot `sidebar.workspaces.session.menu.item`——它渲染
  自绘 `div`，字体和图标与宿主菜单不一致。
- 确认弹窗：注册到 `shell.overlay`，由模块级请求 store 驱动
  （结构化菜单的 `run` 是普通函数，不能持有 React state）。卡片用显式
  中灰底 `#2b2b2e`/浅字 `#e6e6e6`，遮罩保留 `rgba(0,0,0,0.5)`。
- 侧栏「回收站」面板：slot `sidebar.panellist`，行 id `session-recycle-bin`
  只渲染导航图标；点击后由 `ctx.layout.selectPanel('session-recycle-bin')`
  切到 `main` keyed slot 中同 key 的整页（`TrashPanel`）。
- 回收站行右键菜单：自绘 ContextMenu（还原 / 立即永久删除）。
- 提示条：slot `conversation.composer.dock`，id `session-recycle.toast`。
- 客户端只依赖 `react` / `react/jsx-runtime`（宿主模块表的普通条目），
  不用 `@deepseek-ai/dsh-client-ui-primitives`（该包不在 asar 里）。
  `ctx.slots.register(options, Component)` 的组件必须是**第二个参数**。
  `ctx.inject(deps, cb)` 只接受两个参数（第三个 label 无效）。
- 客户端 `sessions` 服务由 `@deepseek-ai/dsh-api-session-controller` 在
  client 根 ctx 提供（service.ts:298）；插件 fiber 用
  `clientCtx.resolve('sessions')` 拿（不要走 `window.__DSH_BOOT__`——那是
  manifest 数据不是 context）。侧边栏刷新靠 `sessions.refresh()`。
