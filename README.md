# Lithe Store

Lithe 的**社区插件市场索引**。这个仓库只存放一份索引文件
[`lithe-plugin-index.json`](lithe-plugin-index.json)，列出社区插件、它们的版本和每个平台的下载包；
插件代码和安装包都留在各自作者的 GitHub 仓库里，通过 GitHub Releases 分发。

> English: This repository is the community plugin index for [Lithe](https://github.com/Lithe-IDEA/Lithe-IDEA).
> Plugin authors publish archives in their own GitHub Releases; this index pins each archive's SHA-256.
> See [docs/publishing.md](docs/publishing.md) to list a plugin.

## 在 Lithe 中使用

需要 Lithe 0.6.1 或更新版本（目前插件市场只在 macOS 提供）。Lithe 已预置本仓库作为社区插件源，
打开 **设置 → 插件 → 插件市场** 即可浏览、安装社区插件，不需要额外配置。

如果你之前移除了 Lithe Store，可以重新添加：

1. 打开 **设置 → 插件 → ⚙ → 管理插件仓库…**
2. 添加 `https://github.com/Lithe-IDEA/Lithe-store`
3. 回到 **插件市场** 标签

Lithe 会把仓库地址解析为
`https://raw.githubusercontent.com/Lithe-IDEA/Lithe-store/HEAD/lithe-plugin-index.json`，
索引缓存在本机缓存目录，不会写入应用安装包。

## 社区插件与官方插件

| | 官方插件 | 社区插件（本仓库） |
| --- | --- | --- |
| 索引位置 | Lithe 主仓库 `Plugins/marketplace/index.json`，随应用附带 | 本仓库，Lithe 预置为社区插件源（用户可停用或移除） |
| ID 命名空间 | `dev.lithe.*` | 不得使用 `dev.lithe.*`，Lithe 会直接拒绝 |
| 完整性 | Lithe 发布者 Ed25519 签名 | 索引固定每个包的 SHA-256，安装后记录内容摘要并在每次加载时复查 |
| 安装前 | 直接安装 | 弹窗列出权限、要运行的程序和来源仓库，用户确认后安装 |

社区插件**由各自的开发者维护**。本仓库的审查只保证：索引格式正确、下载包与 SHA-256 一致、
包内 `plugin.json` 与索引条目一致、来源仓库真实存在且公开。它不代表对插件代码的安全审计。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/publishing.md](docs/publishing.md) | 插件作者：如何打包、发布 Release、提交收录和发布新版本 |
| [docs/versioning-and-updates.md](docs/versioning-and-updates.md) | 版本号如何追踪、Lithe 如何选择可安装版本、用户如何更新/回退 |
| [docs/maintainers.md](docs/maintainers.md) | 维护者：审查清单、下架与撤回、同步 Lithe 契约 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 参与方式总览 |

## 仓库结构

```text
lithe-plugin-index.json         # 唯一的数据文件，Lithe 客户端读取它
schema/plugin-index.schema.json # 索引 JSON Schema（Lithe 契约 v1 的副本）
scripts/validate-index.mjs      # 与 Lithe Rust Core 同规则的校验 + 下载包校验
scripts/track-releases.mjs      # 追踪已收录插件的新 Release 并生成版本条目
scripts/store.test.mjs          # 校验脚本的测试（fixtures 复制自 Lithe 主仓库）
.github/workflows/              # validate（PR/推送/每周）与 track-releases（每 6 小时）
```

本地校验（需要 Node.js 22+ 与 `unzip`）：

```bash
node --test scripts/store.test.mjs
node scripts/validate-index.mjs --verify-archives
```

## 许可

本仓库的脚本与文档使用 [Apache-2.0](LICENSE)。索引中每个插件的许可以该条目的 `license` 字段为准。
