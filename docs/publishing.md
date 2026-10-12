# 发布社区插件

这份文档面向插件作者：从打包到被 Lithe 用户看到的完整流程。

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
（[`shared/contracts/plugins/v1/README.md`](https://github.com/Lithe-IDEA/Lithe-IDEA/blob/preview/shared/contracts/plugins/v1/README.md)）。
社区插件额外要求：

- `plugin.json` 的 `id` 使用你自己的反向域名，例如 `io.github.<你的用户名>.zig-support`；
  **不能**使用 `dev.lithe` 或 `dev.lithe.*`。
- `vendor.signatureRequirement` 必须是 `"none"`（社区包不带 Lithe 签名）。
- `version` 是 `MAJOR.MINOR.PATCH`，每次发布都必须递增，已发布的版本号不能复用。
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

   字段说明见 [schema/plugin-index.schema.json](../schema/plugin-index.schema.json)。`homepage`、
   `localizedDescriptions`、`tags`、`icon` 可选；`icon` 只能是同一仓库的 raw 文件。

2. 统一格式并本地校验（CI 要求索引使用统一格式：两格缩进，纯值列表写在一行）：

   ```bash
   node scripts/validate-index.mjs --write-format
   node scripts/validate-index.mjs --verify-archives
   ```

3. 提交 PR，按模板填写。CI 会下载每个新增的包，核对 SHA-256、包内 `plugin.json` 的
   `id`、`version`、`pluginAPIVersion` 和 `signatureRequirement`。维护者审查后合并。

也可以先开一个 [插件收录申请 issue](../../issues/new?template=plugin-submission.yml)，由维护者帮你提 PR。

## 4. 发布新版本

收录后，新版本**不需要你再提 PR**：

1. 在你的仓库递增 `plugin.json` 的 `version`，打包，发布新的正式 Release（资产命名同上）。
2. `Track plugin releases` 工作流每 6 小时扫描一次已收录插件最近 20 个 Release，
   把新版本写进索引（版本号、`pluginAPIVersion` 取自包内 `plugin.json`，发布日期取 Release
   发布时间，SHA-256 由 CI 计算），然后开一个 `chore(index): 追踪插件新版本` PR。
3. 维护者审查合并后，Lithe 用户刷新插件市场就能看到更新。

想更快上线，可以在 issue 里请维护者手动触发工作流，或者自己提 PR 在 `versions` 里加一项
（保持新版本在前）。

自动追踪会跳过并在日志中说明原因的情况：没有符合命名的 zip、包内 `plugin.json` 不匹配、
多个资产声明了不同的版本号、版本号已被别的资产占用。

## 5. 修改信息、转移或下架

- 修改名称、描述、标签、主页、图标：直接提 PR 修改条目。
- 仓库改名或转移：提 PR 同时更新 `repository` 和所有 `downloadURL`；Lithe 会把它当作同一插件。
- 下架整个插件或撤回某个有问题的版本：开 issue 或提 PR 删除，见
  [维护者文档的下架规则](maintainers.md#下架与撤回)。
