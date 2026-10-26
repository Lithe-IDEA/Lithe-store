# 维护者手册

## 审查清单

CI（`Validate index`）已经自动保证：

- 索引符合 Lithe 契约 v1 与本仓库策略（按 `id` 排序、无重复 ID、无 `dev.lithe.*`）；
- 每个新增或变更的下载包可下载、SHA-256 一致；
- 包内恰好一个匹配的 `plugin.json`，`version`、`pluginAPIVersion` 与索引一致，
  `vendor.signatureRequirement` 为 `"none"`，没有不安全的路径。

维护者人工确认：

- [ ] `repository` 是公开仓库，有 README、许可证，看得出是该作者在维护；
- [ ] 首次收录：`author` 与仓库所有者对应，名称不冒充其他项目或 Lithe 官方；
- [ ] 插件声明要运行的程序与描述相符（看包内 `plugin.json` 的 `languageServers` 与 `executionProviders`）；
- [ ] 描述、标签、图标没有误导内容；
- [ ] 新版本 PR（bot 或作者提交）：版本号递增，没有删除旧版本。

## 自动追踪新版本

`Track plugin releases` 每 6 小时运行一次，也可在 Actions 中手动运行（可只指定一个插件 ID）。
它把结果统一提交到 `bot/track-releases` 分支并开一个 PR，PR 里同时包含索引和重新生成的 README 总览（合并后不需要再等 `Sync README`）；新的扫描会覆盖这个分支并更新 PR 描述。

需要的仓库设置：

1. **Settings → Actions → General → Workflow permissions**：勾选
   “Allow GitHub Actions to create and approve pull requests”。
2. 可选但推荐：创建 `STORE_BOT_TOKEN` secret（fine-grained PAT，仅本仓库，
   Contents 与 Pull requests 读写）。使用默认 `GITHUB_TOKEN` 开的 PR 不会触发
   `Validate index`；工作流已在开 PR 前完成同样的校验，但合并前需要手动运行一次检查才能满足分支保护。
3. 分支保护：`main` 要求 `Validate index / validate` 通过，要求 CODEOWNERS 审查。

## 自动同步 README 总览

README 的插件总览由 `scripts/render-readme.mjs` 根据索引生成。`main` 上的索引、渲染脚本或图片更新后，
`Sync README` 工作流重新生成它；`main` 受保护，工作流不能直接推送，所以和追踪新版本一样，
把结果提交到 `bot/sync-readme` 分支并开一个 PR，下一次运行会覆盖这个分支并更新描述。
合并这个 PR 后工作流会再运行一次，发现总览已经一致就结束。总览已经一致时，上一轮没人合并的同步 PR 会被自动关闭。

仓库设置与追踪新版本相同（“Allow GitHub Actions to create and approve pull requests”，
可选的 `STORE_BOT_TOKEN`）。没有配置 `STORE_BOT_TOKEN` 时，这个 PR 也不会触发 `Validate index`，
需要手动运行一次检查才能满足分支保护。同步 PR 只应该包含 `README.md`；如果还改了别的文件，不要合并。

## 下架与撤回

| 情况 | 处理 |
| --- | --- |
| 某个版本有严重 bug 或安全问题，且已有修复版本 | 删除该版本条目，PR 中写明原因 |
| 某个版本有问题但没有替代版本 | 先联系作者；紧急安全问题可直接删除，其他平台/旧版本仍保留 |
| 每周校验发现资产被删除或替换（SHA-256 不一致） | 开 issue 通知作者；一周内未处理则删除该版本 |
| 插件恶意或冒充 | 立即删除整个条目，并在 issue 中记录 |
| 作者申请下架 | 删除整个条目 |

删除条目只阻止**新的**安装与更新；已经安装的用户不受影响。需要提醒已安装用户时，
在本仓库开 issue 并贴到 Lithe 主仓库。

不要为了“修正”而修改已发布版本的 `downloadURL` 或 `sha256`：Lithe 以它们确认包的身份，
修改等于换包，只能通过新版本发布。

## 跟进插件契约变化

`scripts/validate-index.mjs` 实现与 Lithe Core（`rust/lithe-core/src/plugins/marketplace.rs`）
相同的索引条目规则（本仓库更严格：Lithe 会忽略的无效条目在这里直接让 CI 失败）；
`scripts/fixtures/` 复制自插件契约的 `fixtures/marketplace/`。插件契约的公开副本在
[lithe-plugin-docs](https://github.com/Lithe-IDEA/lithe-plugin-docs) 的 `contract/v1/`，本仓库不再保存 Schema 副本。

`Validate index` 会检查 lithe-plugin-docs 上 `plugin-index.schema.json` 的 SHA-256 是否等于
工作流里记录的值；不一致说明索引契约变了，CI 失败。此时：

1. 对照 lithe-plugin-docs 的提交记录查看 Schema 和契约 README 改了什么；
2. 复制新的 `fixtures/marketplace/{index,invalid-index-entries}.json`，按契约 README 更新 `validate-index.mjs`；
3. 运行 `node --test scripts/store.test.mjs`，所有 fixture 用例必须通过；
4. 把 `.github/workflows/validate.yml` 里的 `SCHEMA_SHA256` 换成新 Schema 的 SHA-256。

如果契约升级到新的 `schemaVersion`，旧版 Lithe 会拒绝整个索引，需要先与主仓库商定迁移方案
（例如并行发布新文件名），不要直接改 `lithe-plugin-index.json` 的 `schemaVersion`。
