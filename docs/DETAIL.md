# 会话回收站（Session Recycle Bin）

删除工作区会话的插件。删除不是立即清除，而是：

1. **移入回收站（待删除）**：在会话上右键 →「移入回收站…」，弹出确认框，
   明确列出该会话清除时将删除的文件清单（会话日志目录、日志文件、
   每会话投影缓存），供人工核对。
2. **7 天后自动清除**：进入回收站的会话每小时被检查一次，超过 7 天自动
   物理删除其文件。
3. **还原**：在「回收站」面板对任意记录点「还原」，会话恢复到工作区列表，
   文件不动。
4. **立即删除**：在回收站记录上点「立即删除」（或右键），弹出确认框并
   再次展示文件清单，确认后不等 7 天直接清除，不可撤销。

![功能预览](preview.svg)

## 界面入口

- 侧栏底部新增「回收站」图标，点击打开回收站面板（列表含剩余天数、
  标题、工作区路径、待删除文件清单）。
- 工作区会话右键菜单新增「移入回收站…」。
- 回收站面板支持列表行右键：还原 / 立即永久删除。
- 操作结果通过输入框上方的提示条反馈；还原、删除后左侧工作区列表
  自动刷新，无需重启。

## 数据与文件

- 回收站记录：`~/.dsh/storages/session_recycle.json`（按 sessionId 存记录，
  含 markedAt / purgeAfter / manifest）。
- 清除对象（每条记录的 manifest）：
  - 会话日志目录 `~/.dsh/sessions/<工作区slug>/session-<id>/`（含
    `session.v4.jsonl.zstd` 与 `session.lock`）。
  - 每会话投影缓存 `~/.dsh/storages/session_projcache/sessions/<id>.json`。

## 已知边界

- 活跃会话（turn/job/schedule/subagent 进行中）移入回收站会被拒绝（409），
  与内置「归档」行为一致。
- 立即删除/到期清除只删除上面列出的会话文件，不动工作区本身；全文搜索
  索引会在下次会话列表刷新时自动校正。
- 若清除瞬间宿主进程正持有该会话的写锁，个别文件可能删除失败——失败项
  会收集在响应的 `removed.errors` 中并提示；回收站记录本身仍会被移除
  （文件已不存在时清理是幂等的）。
- 会话标题取自投影缓存，读不到时回退为 sessionId 前 8 位。

## 安装

要求 DSH ≥ 0.2.2-rc.5。通过插件市场的「自定义插件索引」安装，或手动：

```sh
# 在 DSH profile 目录（默认 ~/.dsh/profiles/desktop）下
mkdir -p node_modules/@local
ln -s /path/to/session-recycle node_modules/@local/session-recycle
```

并在 profile 的 `package.json` 的 `dsh.profile.bundles` 中加入
`session-recycle`，重启 DSH 生效。
