# session-recycle

DeepSeek Harness（DSH）插件：会话回收站。让「删除会话」变成可核对的
两阶段操作——先移入回收站并列出将删除的文件清单，7 天后自动清除；
期间可随时还原或立即永久删除（均需确认）。

## 功能

- 工作区会话右键 →「移入回收站…」，确认框列出待删除文件清单（会话日志
  目录、日志文件、每会话投影缓存）供人工核对
- 侧栏「回收站」面板：所有待删除记录、剩余天数、文件清单
- 记录可还原（文件不动）或立即永久删除（需确认，展示清单）
- 超过 7 天的记录每小时自动物理清除
- 还原/删除后左侧工作区列表自动刷新，无需重启

要求 DSH ≥ 0.2.2-rc.5。详细说明见 [docs/DETAIL.md](docs/DETAIL.md)，
开发笔记见 [DEVELOPMENT.md](DEVELOPMENT.md)。

## 安装（开发/手动方式）

```sh
# 在 DSH profile 目录（默认 ~/.dsh/profiles/desktop）下
mkdir -p node_modules/@local
ln -s /path/to/session-recycle node_modules/@local/session-recycle
```

并在 profile 的 `package.json` 的 `dsh.profile.bundles` 中加入
`session-recycle`，重启 DSH 生效。

## License

MIT
