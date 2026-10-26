# 参与 Lithe Store

| 我想… | 怎么做 |
| --- | --- |
| 收录自己的插件 | 读 [docs/publishing.md](docs/publishing.md)，提 PR 或开“插件收录申请” issue |
| 发布插件新版本 | 在自己仓库发布 Release 即可，bot 会自动开 PR（见 [发布新版本](docs/publishing.md#4-发布新版本)） |
| 修改插件信息 | 提 PR 修改 `lithe-plugin-index.json` 中自己的条目（含 `icon`） |
| 报告有问题的插件 | 开“报告插件问题” issue；安全问题请勾选“安全问题”，维护者会优先处理 |
| 改进脚本、CI 或文档 | 直接提 PR，并运行 `node --test scripts/store.test.mjs` |

规则：

- 一个 PR 只改一个插件，便于审查和回退。
- `plugins` 按 `id` 字母序排列；每个插件的 `versions` 新版本在前。
- 不修改已发布版本的 `downloadURL` 与 `sha256`；不删除历史版本（撤回问题版本除外）。
- README 的插件总览由 `scripts/render-readme.mjs` 根据索引生成，合并到 main 后由 `Sync README` 工作流开一个 `bot/sync-readme` PR 同步（`main` 受保护，不能直接推送），PR 中不需要手动更新。
- 插件图标填在条目的 `icon` 字段，指向插件仓库内固定到提交的 SVG/PNG（`raw.githubusercontent.com/<owner>/<repo>/<commit>/…`）；没有填写时 README 使用默认图标。
- 插件的 bug 与功能请求请提到插件自己的仓库，本仓库只处理收录相关事务。

怎么写插件（开发指南、LSP 与构建工具教程、插件契约和 SDK）见
[lithe-plugin-docs](https://github.com/Lithe-IDEA/lithe-plugin-docs)；写好以后按[发布文档](docs/publishing.md)提交收录。

审查标准见 [docs/maintainers.md](docs/maintainers.md#审查清单)。

## 索引如何工作

这个仓库只存放一份索引文件 [`lithe-plugin-index.json`](lithe-plugin-index.json)，列出社区插件、
它们的版本和每个平台的下载包；插件代码和安装包都留在各自作者的 GitHub 仓库里，通过 GitHub Releases 分发。

Lithe 会把仓库地址 `https://github.com/Lithe-IDEA/Lithe-store` 解析为
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
| [lithe-plugin-docs](https://github.com/Lithe-IDEA/lithe-plugin-docs) | 插件开发：开发指南、LSP 与构建工具教程、插件契约与 JSON Schema、SDK 下载 |
| [docs/publishing.md](docs/publishing.md) | 插件作者：如何打包、发布 Release、提交收录和发布新版本 |
| [docs/versioning-and-updates.md](docs/versioning-and-updates.md) | 版本号如何追踪、Lithe 如何选择可安装版本、用户如何更新/回退 |
| [docs/maintainers.md](docs/maintainers.md) | 维护者：审查清单、下架与撤回、跟进插件契约变化 |

## 仓库结构

```text
lithe-plugin-index.json         # 唯一的数据文件，Lithe 客户端读取它
scripts/validate-index.mjs      # 与 Lithe Rust Core 同规则的校验 + 下载包校验
scripts/track-releases.mjs      # 追踪已收录插件的新 Release 并生成版本条目
scripts/render-readme.mjs       # 根据索引生成 README 的插件总览
scripts/store.test.mjs          # 校验脚本的测试（fixtures 复制自插件契约）
assets/                         # README 用到的图片（无图标插件的默认图标）
.github/workflows/              # validate（PR/推送/每周）、track-releases（每 6 小时）、sync-readme（main 更新后开 PR 同步 README）
```

## 本地校验

需要 Node.js 22+ 与 `unzip`：

```bash
node --test scripts/store.test.mjs
node scripts/validate-index.mjs --verify-archives
node scripts/render-readme.mjs   # 本地预览 README 插件总览
```
