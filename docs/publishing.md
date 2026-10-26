# 发布社区插件

这份文档面向插件作者：从打包到被 Lithe 用户看到的完整流程。

还没有可安装的插件包时，先跟着 lithe-plugin-docs 的
[LSP 插件完整生命周期教程](https://github.com/Lithe-IDEA/lithe-plugin-docs/blob/main/guides/lsp-plugin-lifecycle.md)
完成清单、语言服务器构建和运行验收；需要接入命令、测试或构建后端时，阅读
[构建、运行与测试接入指南](https://github.com/Lithe-IDEA/lithe-plugin-docs/blob/main/guides/build-tool-integration.md)。

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

插件包遵守 Lithe 插件契约 v1
（[`shared/contracts/plugins/v1/README.md`](https://github.com/1lck/Lithe-IDEA/blob/preview/shared/contracts/plugins/v1/README.md)）。
社区插件额外要求：

- `plugin.json` 的 `id` 使用你自己的反向域名，例如 `io.github.<你的用户名>.zig-support`；
  **不能**使用 `dev.lithe` 或 `dev.lithe.*`。
- `vendor.signatureRequirement` 必须是 `"none"`（社区包不带 Lithe 签名）。
- `version` 是 `MAJOR.MINOR.PATCH`，每次发布都必须递增，已发布的版本号不能复用。
- `pluginAPIVersion: 3` 必须有非空 `requires`，逐项声明包实际使用的能力及其契约版本。
  例如只使用声明式构建系统的包为 `"requires": { "buildSystems": 1 }`；不要无故增加
  `buildProviders` 等能力。API 1/2 继续使用原有格式，不能带 `requires`。
  API 4（调试适配器）同样在 `requires` 里逐项声明，例如 `"debugAdapters": 1`。
- `requires` 的键是小写字母开头、后接英文字母或数字、最长 64 个字符的能力 ID，
  值是正整数。索引允许未知能力 ID，由宿主能力表决定可安装性；这不表示当前宿主支持它。
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
能力表按键和值比较，键的书写顺序可以不同。API 3 索引版本项必须逐项复制包清单的
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
         "pluginAPIVersion": 1,
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

   字段说明见 [plugin-index.schema.json](https://github.com/Lithe-IDEA/lithe-plugin-docs/blob/main/contract/v1/plugin-index.schema.json)。`homepage`、
   `localizedDescriptions`、`tags`、`icon` 可选；`icon` 只能是同一仓库的 raw 文件。
   API 3 的版本项还必须在 `pluginAPIVersion` 旁加入与包内相同的能力表，例如：

   ```json
   "pluginAPIVersion": 3,
   "requires": { "buildSystems": 1 }
   ```

   提高 API 等级或能力版本时发布新的插件版本，并保留最后一个旧要求的版本项，
   让旧宿主仍能选择可安装版本。Core 对 API 3 以上的索引项允许省略 `requires`，
   提供时仍校验能力表；API 4 的版本项应像 API 3 一样逐项复制包内的 `requires`
   （自动追踪就是这样写的），宿主才能据此判断自己是否具备这些能力。

2. 统一格式并本地校验（CI 要求索引使用统一格式：两格缩进，纯值列表写在一行）：

   ```bash
   node scripts/validate-index.mjs --write-format
   node scripts/validate-index.mjs --verify-archives
   ```

3. 提交 PR，按模板填写。CI 会下载每个新增或校验预期发生变化的包，核对 SHA-256、
   包内 `plugin.json` 的 `id`、`version`、`pluginAPIVersion`、`requires` 和
   `signatureRequirement`。即使 URL 和 SHA-256 不变，修改 ID、版本、API 等级或能力表
   也会重新校验；完整校验不使用基线跳过。维护者审查后合并。

索引与归档检查只覆盖上述发布字段、社区信任声明和现有路径检查，不替代完整的 Core
清单校验或插件运行验收。安装端仍由 Core 验证能力是否与清单实际内容相符，并由宿主
检查能力支持情况。没有运行这些验证时，PR 应明确标记为待验证。

也可以先开一个 [插件收录申请 issue](../../issues/new?template=plugin-submission.yml)，由维护者帮你提 PR。

## 4. 发布新版本

收录后，新版本**不需要你再提 PR**：

1. 在你的仓库递增 `plugin.json` 的 `version`，打包，发布新的正式 Release（资产命名同上）。
2. `Track plugin releases` 工作流每 6 小时扫描一次已收录插件最近 20 个 Release，
   把新版本写进索引（版本号、`pluginAPIVersion`、`requires` 取自包内 `plugin.json`，
   能力表按键排序写入；发布日期取 Release 发布时间，SHA-256 由 CI 计算），
   然后开一个 `chore(index): 追踪插件新版本` PR。
3. 维护者审查合并后，Lithe 用户刷新插件市场就能看到更新。

想更快上线，可以在 issue 里请维护者手动触发工作流，或者自己提 PR 在 `versions` 里加一项
（保持新版本在前）。

自动追踪只收录正式 Release，继续跳过 draft 和 pre-release；预发布版本需要手工提交
索引条目并接受相同的校验，不能靠调整追踪策略自动收录。Maven、Gradle 的 `0.1.0`
预发布收录属于这种手工流程，条目是否存在不代表发布或运行验证已经完成。

需要新插件 API 的版本（例如调试适配器插件需要 API 4）要等到稳定版 Lithe 支持该 API 才能让
稳定版用户安装；稳定版是否支持，以 Lithe 的发行说明为准。支持之前，把 GitHub Release 标为
预发布，并手工提交索引条目（LLDB Debugger `0.1.0` 就是这样收录的）。稳定版 Lithe 遇到自己
不支持的 API 等级只会显示“需要更新 Lithe”，不会安装，所以不会装出坏插件。稳定版支持之后，
把 Release 转为正式发布（或发布新版本），自动追踪就会接手后续版本。调试适配器插件的写法见
[编写调试适配器插件](https://github.com/Lithe-IDEA/lithe-plugin-docs/blob/main/guides/debug-adapter-plugin.md)。

自动追踪会在日志中说明归档无法收录的原因：没有符合命名的 zip、包内 `plugin.json`
不匹配或缺失/畸形的能力表、多个资产声明了不同的版本号、API 等级或能力表、
版本号已被别的资产占用。单个发布存在分歧时拒绝整个版本，不只保留其中一个平台包。

## 5. 修改信息、转移或下架

- 修改名称、描述、标签、主页、图标：直接提 PR 修改条目。
- 仓库改名或转移：提 PR 同时更新 `repository` 和所有 `downloadURL`；Lithe 会把它当作同一插件。
- 下架整个插件或撤回某个有问题的版本：开 issue 或提 PR 删除，见
  [维护者文档的下架规则](maintainers.md#下架与撤回)。
