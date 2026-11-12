# 发布插件

这份文档面向插件作者：从打包到被 Lithe 用户看到的完整流程。

插件契约、开发指南和 SDK 都在 Rust Core 仓库的 [`shared/plugins/`](https://github.com/Lithe-IDEA/Lithe-core-rust/tree/main/shared/plugins)。
还没有可安装的插件包时，先跟着
[LSP 插件完整生命周期教程](https://github.com/Lithe-IDEA/Lithe-core-rust/blob/main/shared/plugins/guides/lsp-plugin-lifecycle.md)
完成清单、语言服务器构建和运行验收；需要接入命令、测试或构建后端时，阅读
[构建、运行与测试接入指南](https://github.com/Lithe-IDEA/Lithe-core-rust/blob/main/shared/plugins/guides/build-tool-integration.md)。

```text
你的插件仓库                          Lithe-store                      Lithe 用户
───────────                          ───────────                      ─────────
1. 改 plugin.json 版本
2. 打包 zip，发布 GitHub Release ──▶ 3. 首次：你提 PR 收录插件
                                     之后：track-releases 自动开 PR
                                     4. CI 下载并校验，维护者审查合并 ──▶ 5. 刷新插件市场，
                                                                          看到新版本并确认安装/更新
```

## 1. 插件包要求

插件包遵守 Lithe 插件契约 v0
（[`shared/plugins/contract/v1/README.md`](https://github.com/Lithe-IDEA/Lithe-core-rust/blob/main/shared/plugins/contract/v1/README.md)；目录名仍是 `v1`，
其中的格式版本都是 `0`）。只有新版 Lithe 桌面端（`desktop-v*`）能安装 v0 插件，旧版 macOS Lithe
读不了本仓库的索引。收录到本仓库的插件额外要求：

- `plugin.json` 的 `id` 使用你自己的反向域名，例如 `io.github.<你的用户名>.zig-support`；
  **不能**使用 `dev.lithe` 或 `dev.lithe.*`。
- `vendor.signatureRequirement` 必须是 `"none"`（插件包不带发布者签名）。
- `version` 是 `MAJOR.MINOR.PATCH`，每次发布都必须递增，已发布的版本号不能复用。
- `plugin.json` 的 `schemaVersion` 和 `pluginAPIVersion` 都必须是 `0`，其他值的包不收录。
- `requires` 必填且不能为空，逐项列出包实际使用的能力，目前每项的版本都是 `0`。
  例如只使用声明式构建系统和设置的包为 `"requires": { "buildSystems": 0, "settings": 0 }`；
  不要列出没用到的能力，也不要漏掉用到的能力，Core 会拒绝两者不一致的清单。
- `requires` 的键是小写字母开头、后接英文字母或数字、最长 64 个字符的能力 ID，
  值是非负整数。索引允许未知能力 ID 和更高的能力版本，由宿主能力表决定能不能安装；
  这不表示当前宿主支持它。
- 包内路径只用 `/`，不能有 `..`、绝对路径或符号链接。
- 可以附带可执行文件（例如打包好的语言服务器），但它们必须在 `plugin.json` 中声明；
  用户安装前会看到完整的程序列表并确认。版本更新新增了程序时，用户需要重新确认。

## 2. 打包与 Release 命名

每个平台一个 `.zip`，整个包放在一个目录下（推荐以插件 ID 命名），zip 中**只能有一个**
`id` 等于你插件 ID 的 `plugin.json`：

```text
zig-support-2.0.0-darwin-arm64.zip
└── io.github.alice.zig-support/
    ├── plugin.json
    └── …
```

同一插件版本的所有平台包必须使用相同的 `version`、`pluginAPIVersion` 和 `requires`。
能力表按键和值比较，键的书写顺序可以不同。索引版本项必须逐项复制包清单的
`requires`；不同平台需要不同能力时，应使用不同的插件版本，不能共用一个版本项。

Release 资产名必须以平台结尾，自动追踪才能识别：

| 资产名结尾 | 对应平台 |
| --- | --- |
| `-darwin-arm64.zip` / `-darwin-x64.zip` | Apple Silicon / Intel Mac |
| `-windows-x64.zip` / `-windows-arm64.zip` | Windows |
| `-linux-x64.zip` / `-linux-arm64.zip` | Linux |
| `-darwin.zip`（或 `-windows.zip`、`-linux.zip`） | 一个包同时服务该系统的 arm64 与 x64 |

在**你自己的仓库**发布一个正式 Release（不是 draft，也不是 pre-release），把这些 zip 作为资产上传。
索引只接受 `https://github.com/<你的仓库>/releases/download/<tag>/<资产>.zip`，
不能指向其他仓库、源码压缩包或其他网站。

> Release 发布后**不要替换或删除资产**。索引固定了 SHA-256，替换后用户会安装失败，
> 每周的校验也会把它标记为损坏。需要修复就发一个新的补丁版本。

计算 SHA-256：

```bash
shasum -a 256 zig-support-2.0.0-darwin-arm64.zip
```

## 3. 首次收录

Lithe-IDEA 组织下名为 `lithe-plugin-*` 的公开仓库（已退役的文档仓库 `lithe-plugin-docs` 除外，它不发布插件）
不需要手工提交首次收录 PR。`Track plugin releases` 发现这类仓库还没收录、并且已经有带插件包的
正式 Release 时，会把它连同全部正式版本一起放进组织插件的 bot PR，校验通过后自动合入 main，
条目按以下来源生成：

| 字段 | 来源 |
| --- | --- |
| `id`、`name`、`author` | 最新正式 Release 的包内 `plugin.json`：`id`、`displayName`、`vendor.displayName` |
| `repository`、`homepage` | 仓库地址，`homepage` 为 `<仓库地址>#readme` |
| `description` | GitHub 仓库简介，原样使用 |
| `license` | GitHub 识别出的许可证（SPDX ID） |
| `tags` | 仓库 topics；没有 topics 时省略 |

仓库是私有、已归档或 fork，仓库没有简介，GitHub 识别不出许可证，包内 `plugin.json` 缺字段或 ID 不符合索引规则，
或者 ID 已经被别的条目占用时，自动收录会跳过该仓库，并在工作流日志里写明原因。自动生成的条目
没有 `icon` 和 `localizedDescriptions`，自动合入后由维护者另提 PR 补充。和版本追踪一样，只发布过
pre-release 的仓库不会被收录。

其他仓库按下面的步骤收录：

1. Fork 本仓库，在 `lithe-plugin-index.json` 的 `plugins` 中**按 `id` 字母序**插入你的条目：

   ```json
   {
     "id": "io.github.alice.zig-support",
     "name": "Zig Support",
     "author": "Alice",
     "repository": "https://github.com/alice/lithe-zig",
     "homepage": "https://github.com/alice/lithe-zig#readme",
     "description": "Zig language server and test runner integration.",
     "localizedDescriptions": { "zh-Hans": "Zig 语言服务器与测试运行集成。" },
     "tags": ["language", "zig"],
     "license": "MIT",
     "icon": "https://raw.githubusercontent.com/alice/lithe-zig/main/icon.png",
     "versions": [
       {
         "version": "2.0.0",
         "pluginAPIVersion": 0,
         "requires": { "languageServers": 0, "languages": 0 },
         "releaseDate": "2026-10-12",
         "downloads": [
           {
             "platforms": ["darwin-arm64"],
             "downloadURL": "https://github.com/alice/lithe-zig/releases/download/v2.0.0/zig-support-2.0.0-darwin-arm64.zip",
             "sha256": "<64 位小写十六进制>"
           }
         ]
       }
     ]
   }
   ```

   字段说明见 [plugin-index.schema.json](https://github.com/Lithe-IDEA/Lithe-core-rust/blob/main/shared/plugins/contract/v1/plugin-index.schema.json)
   和[插件市场参考](https://github.com/Lithe-IDEA/Lithe-core-rust/blob/main/shared/plugins/reference/domains/marketplace.md)。`homepage`、
   `localizedDescriptions`、`tags`、`icon` 可选；`icon` 只能是同一仓库的 raw 文件。
   每个版本项的 `pluginAPIVersion` 和 `requires` 都必须与包内 `plugin.json` 相同
   （自动追踪就是这样写的），宿主不用下载就能据此判断自己是否具备这些能力。

   以后改用新的能力版本时发布新的插件版本，并保留最后一个旧要求的版本项，
   让还没支持新版本的宿主仍能选择可安装版本。

2. 统一格式并本地校验（CI 要求索引使用统一格式：两格缩进，纯值列表写在一行）：

   ```bash
   node scripts/validate-index.mjs --write-format
   node scripts/validate-index.mjs --verify-archives
   ```

3. 提交 PR，按模板填写。CI 会下载每个新增或校验预期发生变化的包，核对 SHA-256、
   包内 `plugin.json` 的 `id`、`version`、`schemaVersion`、`pluginAPIVersion`、`requires` 和
   `signatureRequirement`。即使 URL 和 SHA-256 不变，修改 ID、版本、插件 API 版本或能力表
   也会重新校验；完整校验不使用基线跳过。维护者审查后合并。

索引与归档检查只覆盖上述发布字段、社区信任声明和现有路径检查，不替代完整的 Core
清单校验或插件运行验收。安装端仍由 Core 验证能力是否与清单实际内容相符，并由宿主
检查能力支持情况。没有运行这些验证时，PR 应明确标记为待验证。

也可以先开一个 [插件收录申请 issue](../../issues/new?template=plugin-submission.yml)，由维护者帮你提 PR。

## 4. 发布新版本

收录后，新版本**不需要你再提 PR**：

1. 在你的仓库递增 `plugin.json` 的 `version`，打包，发布新的正式 Release（资产命名同上）。
2. `Track plugin releases` 工作流每 6 小时扫描一次已收录插件最近 20 个 Release
   （Lithe-IDEA 组织尚未收录的 `lithe-plugin-*` 仓库也一起扫描，见 [首次收录](#3-首次收录)），
   把新版本写进索引（版本号、`pluginAPIVersion`、`requires` 取自包内 `plugin.json`，
   能力表按键排序写入；发布日期取 Release 发布时间，SHA-256 由 CI 计算），
   然后按插件仓库的所有者开 PR：Lithe-IDEA 组织插件进 `chore(index): 追踪 Lithe-IDEA 组织插件新版本`，
   校验通过后由工作流直接合入；其他插件进 `chore(index): 追踪组织外插件新版本`。
3. 组织外插件的 PR 由维护者审查后合并。新版本进入 main 后，Lithe 用户刷新插件市场就能看到更新。

想更快上线，可以在 issue 里请维护者手动触发工作流，或者自己提 PR 在 `versions` 里加一项
（保持新版本在前）。

自动追踪只收录正式 Release，继续跳过 draft 和 pre-release；预发布版本需要手工提交
索引条目并接受相同的校验，不能靠调整追踪策略自动收录。条目是否存在不代表发布或运行验证已经完成。

新版 Lithe 桌面端以 `desktop-v*` 预发布版本发布期间，v0 插件也以 GitHub 预发布版本发布，
并手工提交索引条目（Go Support、Maven、LLDB Debugger 的 `0.0.1` 就是这样收录的）。
宿主遇到自己不具备的能力或能力版本只会显示“需要更新 Lithe”，不会安装，所以不会装出坏插件。
桌面端发布正式版之后，把 Release 转为正式发布（或发布新版本），自动追踪就会接手后续版本；
还没收录的 Lithe-IDEA 组织插件会在这时被自动首次收录。调试适配器插件的写法见
[编写调试适配器插件](https://github.com/Lithe-IDEA/Lithe-core-rust/blob/main/shared/plugins/guides/debug-adapter-plugin.md)。

自动追踪会在日志中说明归档无法收录的原因：没有符合命名的 zip、包内 `plugin.json`
不匹配或缺失/畸形的能力表、多个资产声明了不同的版本号、插件 API 版本或能力表、
版本号已被别的资产占用。单个发布存在分歧时拒绝整个版本，不只保留其中一个平台包。

## 5. 修改信息、转移或下架

- 修改名称、描述、标签、主页、图标：直接提 PR 修改条目。
- 仓库改名或转移：提 PR 同时更新 `repository` 和所有 `downloadURL`；Lithe 会把它当作同一插件。
- 下架整个插件或撤回某个有问题的版本：开 issue 或提 PR 删除，见
  [维护者文档的下架规则](maintainers.md#下架与撤回)。
