# 第三方材料与声明

第三方许可的**盘点、声明生成、发布门禁**集中在一条脚本里：[`scripts/licenses.mjs`](../scripts/licenses.mjs)。
本目录存放它的输入数据（覆盖表、来源台账）与上游原文快照；生成物是仓库根的
[THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md)。

## 命令

```bash
node scripts/licenses.mjs notices       # 生成 THIRD-PARTY-NOTICES.md（精确版本、原始版权与许可文本）
node scripts/licenses.mjs check         # 手动门禁：出现 allowlist 之外或许可未知的包即退出码 1
node scripts/licenses.mjs check --strict # 发布前必跑：额外要求声明材料已核验齐全
```

> **发布纪律**：`check` 通过不等于合规完成。存在待补齐/核验材料时脚本会列出条数并提示
> 必须跑 `check --strict`，不得把基础检查通过当作合规完成。

## 数据口径（`licenses.mjs` 头部原文）

- **实装清单** = 全 workspace `node_modules` 的递归集合，含嵌套版本与符号链接。
- **声明生成**：`third-party-npm.mjs` 按生产依赖的**精确版本**收集真实许可文件。
- **prod 判定**按锁文件生产图中的精确版本，不按包名猜测。
- **商用/半开放检查作用于全量实装包**（prod + dev）。

## 目录内容

| 文件 / 目录                | 职责                                                               |
| -------------------------- | ------------------------------------------------------------------ |
| `inventory.json`           | 来源台账：输入哈希、声明摘要、包清单、例外、待核验项等             |
| `npm-overrides.json`       | npm 包声明覆盖（原包缺失/不合规声明时指向本地快照原文）            |
| `copied-components.json`   | **复制进仓库**的第三方源码/资产（如 shadcn），登记上游 URL 与哈希  |
| `embedded-components.json` | **嵌在依赖内部**的组件（如 `@napi-rs/canvas` 内的 Skia），单独登记 |
| `upstream/`                | 上游许可与源码快照原文，按内容哈希命名，供声明生成引用             |
| `runtime/`                 | 随包运行时（Electron/Node 等）的来源声明                           |
| `native-search/`           | 原生搜索工具归档的来源声明                                         |

`inventory.json` 的 `scope` 字段明确口径：**生产依赖并集 + 复制源/资产 + 原生工具**，
不是逐安装包 SBOM，也不是对任何发行物的合规认证。`inputHashEncoding` 说明了哈希的
换行归一化规则（CRLF → LF；声明与源快照哈希仍按字节精确）。

## 许可分桶

`check` 用统一分类器给每个实装包归桶（见 `licenses.mjs` 的 `classify`）：

| 桶             | 含义                                                                   | 处置             |
| -------------- | ---------------------------------------------------------------------- | ---------------- |
| `green`        | 宽松许可（MIT/BSD/Apache-2.0/ISC/Zlib/Unlicense 等及合规 AND/OR 组合） | 放行             |
| `yellow-lgpl`  | LGPL                                                                   | 需复核（弱传染） |
| `yellow-weak`  | MPL / EPL / CDDL                                                       | 需复核（文件级） |
| `yellow-cc`    | CC-BY-ND / CC-BY-SA                                                    | 需复核           |
| `review`       | 其余未归类、需人工判断                                                 | 需复核           |
| `missing`      | 许可字段缺失                                                           | 拒绝             |
| `unresolved`   | UNLICENSED / SEE LICENSE / UNKNOWN                                     | 拒绝             |
| `red-gpl`      | GPL                                                                    | 拒绝             |
| `red-agpl`     | AGPL                                                                   | 拒绝             |
| `red-semiopen` | BUSL / BSL / Elastic / SSPL / PolyForm / FSL / CAL-1                   | 拒绝             |
| `red-nc`       | CC-BY-NC                                                               | 拒绝             |

门禁判定（`check`）：只有 `green` 放行；`yellow*` 需命中 `weakAllowReason`（弱传染豁免理由）
才跳过，其余一律退出码 1。人工复核结论登记进 `scripts/licenses.mjs` 的 `WEAK_ALLOW`，不改上游
许可本身。两点注意：**豁免只对非生产包生效**（生产包恒不豁免），且这是**构建工具许可标识复核，
不等于二进制发行义务豁免**。

## 声明在发行物中的落点

- **`THIRD-PARTY-NOTICES.md`**：由 `notices` 生成，经 electron-builder `extraResources`
  打进安装目录根（见 `packages/desktop/electron-builder.config.js`）。
- **Electron 自身声明**：`stageElectronNotices` 写入
  `<安装目录>/resources/licenses/electron/THIRD-PARTY-NOTICES.txt`。

## 维护要点

- 新增/升级依赖后重跑 `node scripts/licenses.mjs notices`，并确认 `inventory.json` 台账同步。
- 复制进仓库的第三方源码，必须在 `copied-components.json` 登记上游 URL 与内容哈希，
  原文快照放入 `upstream/`。
- 嵌套在依赖内的组件（原生库自带的子项目）在 `embedded-components.json` 单独登记，
  不能因为父包许可通过就视为已覆盖。
- 发布前跑 `node scripts/licenses.mjs check --strict`，并核对 `reviewRequired` 清空。
