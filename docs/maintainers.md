# 维护者手册

## 审查清单

CI（`Validate index`）已经自动保证：

- 索引符合 Lithe 契约 v1 与本仓库策略（按 `id` 排序、无重复 ID、无 `dev.lithe.*`）；
- 每个新增或变更的下载包可下载、SHA-256 一致；
- 包内恰好一个匹配的 `plugin.json`，`version`、`pluginAPIVersion` 与索引一致，
  `vendor.signatureRequirement` 为 `"none"`，没有不安全的路径。

维护者人工确认（Lithe-IDEA 组织插件的 bot PR 由工作流自动合入，不走这份清单，见[自动追踪新版本](#自动追踪新版本)）：

- [ ] `repository` 是公开仓库，有 README、许可证，看得出是该作者在维护；
- [ ] 首次收录：`author` 与仓库所有者对应，名称不冒充其他项目或 Lithe 官方；
- [ ] 插件声明要运行的程序与描述相符（看包内 `plugin.json` 的 `languageServers` 与 `executionProviders`）；
- [ ] 描述、标签、图标没有误导内容；
- [ ] 新版本 PR（bot 或作者提交）：版本号递增，没有删除旧版本。

bot 首次收录的组织插件（组织 PR 描述里的“首次收录”）合入后，维护者补做两件事：

- 检查仓库简介是否适合作为 `description`，仓库 topics 是否适合作为 `tags`，不合适就另提 PR 修改；
- 另提 PR 补充 `icon`、`localizedDescriptions`。不要直接改 `bot/track-organization-releases`，下一轮扫描会从 main 重建这个分支。

## 自动追踪新版本

`Track plugin releases` 每 6 小时运行一次，也可在 Actions 中对 `main` 手动运行（可只指定一个插件 ID；从其他分支启动不会执行）。
它扫描已收录插件的 Release，以及 Lithe-IDEA 组织下尚未收录的公开 `lithe-plugin-*` 仓库
（`lithe-plugin-docs` 不发布插件，固定排除），只收录正式 Release；新插件的条目生成规则见
[发布社区插件的首次收录](publishing.md#3-首次收录)。手动运行时指定的插件 ID 可以是已收录插件，
也可以是组织中尚未收录的插件。

扫描按插件仓库的所有者分两轮，先组织插件、后组织外插件，每轮维护一个 bot PR：

| | Lithe-IDEA 组织插件 | 组织外插件 |
| --- | --- | --- |
| 范围 | `repository` 属于 Lithe-IDEA 组织的已收录插件，以及新发现的组织 `lithe-plugin-*` 仓库 | 其他已收录插件；不会被自动首次收录 |
| 分支 | `bot/track-organization-releases` | `bot/track-releases` |
| 合入 | 校验通过后由工作流直接合入 main，不经人工审查 | 维护者按[审查清单](#审查清单)审查后合并 |

两个 PR 都同时包含索引和重新生成的 README 总览，合入后不需要再等 `Sync README`。每轮扫描从 main 重建
对应分支并更新 PR；某一轮没有发现 main 尚未收录的版本时，这一轮遗留的 PR 会被自动关闭
（只指定一个插件的手动运行不会关闭 PR）。

组织插件的自动合入分三步：

1. 开 PR 之前运行 `validate-index.mjs --verify-archives`，与 `Validate index` 对新增归档的检查相同；
2. 用 `STORE_BOT_DEPLOY_KEY` 把 main 快进到 PR 的提交，GitHub 据此把 PR 标为已合并；
3. PR 标为已合并后删除分支。

main 在扫描期间被别人更新时快进会失败；没有配置 `STORE_BOT_DEPLOY_KEY` 时工作流不尝试合入。
这两种情况都只在工作流里给出警告，PR 保持打开，由维护者按审查清单审查后合并，下一轮扫描也会基于新的 main 重建它。
删除 deploy key 或 secret 即可停止自动合入。

信任边界：在任一 Lithe-IDEA 组织插件仓库能发布 Release 的人，以及能在组织里创建公开
`lithe-plugin-*` 仓库的人，都可以不经 Store 维护者审查把插件发布到 Lithe Store。
授予组织成员身份或插件仓库写权限时按这个标准判断。

需要的仓库设置：

1. **Settings → Actions → General → Workflow permissions**：勾选
   “Allow GitHub Actions to create and approve pull requests”。
2. **Settings → Deploy keys**：一把允许写入的 deploy key
   （`lithe-store-bot (track organization releases)`），私钥保存为 `STORE_BOT_DEPLOY_KEY` secret。
   只有组织插件那一轮的 checkout 会拿到这把 key，组织外那一轮仍用 `GITHUB_TOKEN`，写不了 main。
3. **Settings → Rules → Rulesets**：规则集 “Only owners merge main” 限制 `main` 的更新、删除和强制推送，
   只有组织管理员和 deploy key 可以绕过。GitHub 不允许把 GitHub Actions 加入仓库规则集的绕过名单，
   所以工作流用 deploy key 写 main。这项绕过对仓库的所有 deploy key 生效，新增其他 deploy key 前先评估。
4. 可选：创建 `STORE_BOT_TOKEN` secret（fine-grained PAT，仅本仓库，Contents 与 Pull requests 读写）。
   使用默认 `GITHUB_TOKEN` 开的 PR 不会触发 `Validate index`；工作流已在开 PR 前完成同样的校验。
   deploy key 推送到 main 会正常触发 main 上的 `Validate index` 和 `Sync README`。

## 自动同步 README 总览

README 的插件总览由 `scripts/render-readme.mjs` 根据索引生成。`main` 上的索引、渲染脚本或图片更新后，
`Sync README` 工作流重新生成它；`main` 受保护，工作流不能直接推送，所以和追踪新版本一样，
把结果提交到 `bot/sync-readme` 分支并开一个 PR，下一次运行会覆盖这个分支并更新描述。
合并这个 PR 后工作流会再运行一次，发现总览已经一致就结束。总览已经一致时，上一轮没人合并的同步 PR 会被自动关闭。

仓库设置与追踪新版本相同（“Allow GitHub Actions to create and approve pull requests”，
可选的 `STORE_BOT_TOKEN`），同步 PR 不使用 deploy key，始终由维护者合并。没有配置 `STORE_BOT_TOKEN` 时，
这个 PR 也不会触发 `Validate index`。同步 PR 只应该包含 `README.md`；如果还改了别的文件，不要合并。

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
