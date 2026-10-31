# dsh-qq-bot

把已经在用的 DSH 会话接到 QQ 个人号。协议是 OneBot，常用实现是 NapCat。

Cordis 插件 id 是 `qq-bridge`。npm 包名是 `@fengye_nobug/dsh-qq-bot`。界面显示名是 dsh-qq-bot。

唤醒、出站、图片、NapCat 和全部设置项见 [`DESIGN.md`](./DESIGN.md)。变更见 [`CHANGELOG.md`](./CHANGELOG.md)。

## 简介

消息进入你指定的会话，回答可以发回 QQ。白名单默认全关。被 @、叫到昵称或被戳时会叫醒；其余消息按概率抽样。群白名单可以由主人在 QQ 里用整句命令修改。

## 功能

- 接到一个已有会话，或按群、按私聊各记一条会话。
- 白名单留空时，任何群和私聊都不会叫醒。
- 被 @、命中昵称、被戳一定叫醒。其余按 `wakeProbability`（默认 `0.05`）抽样，没抽中只记录。
- 发回 QQ 的内容由 `replyMode` 决定。在 DSH 界面里聊同一个会话时，正文不会进群。
- 图片先落盘，叫醒时写成文字。表情包可以登记后再发。`[笑哭]` 这类写法会变成 QQ 系统表情。
- 设置卡片在 **设置 → 插件 → 插件配置 → QQ 桥接**。可以检查更新；有新正式版时一键安装，并重启面板。
- 可以按需下载、配置、启停 NapCat。加载插件时不会自己下载或执行。

不做审批桥接，也不走 QQ 官方机器人。

## 安装

日常安装用 npm 上已经发出的版本。仓库源码如果比已发布的版本新，不要直接装 main。

```sh
dsh plugin --profile web add @fengye_nobug/dsh-qq-bot@0.2.5
```

registry 里还没有这一版时：

```sh
dsh plugin --profile web add github:yunfengnobug/dsh-qq-bot#v0.2.5
```

装完重启 dsh-web。

环境：DSH 0.1.5-rc.3，或 0.2.0 及以后；Node ≥ 22；NapCat 的 OneBot v11 正向 WebSocket。

`cordis.patch.yml` 里 `qq-bridge` 的 `name` 写成 `@fengye_nobug/dsh-qq-bot`。写成 `dsh-qq-bot` 或 `dsh-qq-bridge` 时插件挂不上，设置接口是 HTTP 404。

不要和另一个 Cordis id 也是 `qq-bridge` 的 QQ 插件一起挂，它们会抢同一条 OneBot。已经装着 `dsh-qq-bridge` 时，先卸掉再装上面的包，然后重启。profile 里按 `id: qq-bridge` 写的覆盖可以留着；其中的 `name` 同样写成 `@fengye_nobug/dsh-qq-bot`。

升级的几条路径、开发期怎么链到本地目录，见 [`DESIGN.md`](./DESIGN.md) 的「使用细节」。

## 配置

白名单默认全关。先在设置卡片里填「哪些群可以叫醒」或「哪些私聊可以叫醒」，保存后再去 @。不要把真实群号、QQ 号写进仓库。

DSH 0.2 的卡片把值写进 `$DSH_HOME/qq-bridge-settings.json`。这份文件比 `cordis.patch.yml` 优先，保存后马上生效，重启还在。只改 `cordis.patch.yml` 要重启。

主人 QQ（`ownerWhitelist`，默认 `[]`）决定谁能在 QQ 里改群白名单。**留空 = 这些命令不会生效。** 设置卡片里还没有这一项，写在下面两处之一：

- 设置文件的 `values.ownerWhitelist`：下一条消息就生效。
- profile 的 `cordis.patch.yml`：要重启。设置文件里已有同名键时，以设置文件为准。

`accessTokenEnv` 填凭据引用名（一个环境变量名）。token 由 DSH 凭据服务解析，不要写进配置文件。每次建连重新解析。

| 键 | 默认 | 效果 |
|---|---|---|
| `targetSessionId` | 空 | `single` 时接到哪个会话。留空 = 不接到任何会话 |
| `sessionScope` | `single` | `perGroup` 时每个群、每个私聊各一条会话 |
| `nicknames` | `244`、`小助手` | 听到这些名字就叫醒 |
| `wakeProbability` | `0.05` | 没点名时的叫醒概率 |
| `whitelist` | `[]` | 哪些私聊可以叫醒。留空 = 都不叫醒 |
| `groupWhitelist` | `[]` | 哪些群可以叫醒。留空 = 都不叫醒 |
| `ownerWhitelist` | `[]` | 主人 QQ。留空 = 不能在 QQ 里改群白名单 |
| `onebotUrl` | 空 | NapCat 正向 WebSocket。留空 = 不连接 |
| `atOnlyInGroup` | `false` | 打开后，群里没被 @ 就不处理 |
| `replyMode` | `marker` | 群里发出去的是哪一段：只发「发给群」里的那段 |

其余键见 [`DESIGN.md`](./DESIGN.md)。

## 使用

在群里 @ 机器人，或叫出昵称。白名单没填时不会醒。

主人改群白名单时，整句必须就是命令，前面可以加一个 `/`。多出来的字不当命令。不是主人时按普通聊天处理：不改配置，也没有单独的拒绝回复。还没进白名单的群，主人仍能在群里直接加。调试工具模拟的消息不会改白名单。

| 在哪 | 整句 | 作用 |
|---|---|---|
| 群里 | `白名单 加`、`白名单 加本群` | 把当前群加进群白名单 |
| 群里 | `白名单 删`、`白名单 删本群` | 把当前群移出 |
| 群或私聊 | `白名单 加 群号`、`白名单 删 群号` | 按写明的群号加或删 |
| 群或私聊 | `白名单`、`白名单 列表` | 回复现在有几个群 |
| 私聊 | `白名单 加`（没写群号） | 不改配置，提示要写群号 |

删到一个群都不剩时，回复会说明现在任何群都不会叫醒。保存方式和设置卡片相同。

`replyMode` 为 `marker` 时，模型把要发到群里的话放进 `[QQ]…[/QQ]`。会话跟随、表情包和戳一戳见 [`DESIGN.md`](./DESIGN.md)。

## 更新

设置卡片里先点「检查更新」。有新正式版时点「更新到 vX.Y.Z」。优先从 npm 安装；这一版还没发到 npm 时，改从 GitHub 下载。装完会自己重启 dsh-web。设置还在，不改 NapCat。刷新页面后，登录口令可能会变。

「检查更新」和「启动时检查一次」只询问，不会安装。

维护者发版：

1. 改 `package.json` 的 `version`。
2. 在 [`CHANGELOG.md`](./CHANGELOG.md) 顶部写这一版。
3. 推到 `main`。

推到 `main` 后，Actions 在 npm 上还没有 `@fengye_nobug/dsh-qq-bot` 的这一版时才发布，并补 tag `vX.Y.Z` 和 GitHub Release。`NPM_TOKEN` 放在仓库 Actions Secrets，不写进仓库。

## 许可

MIT。详见 [`LICENSE`](./LICENSE)。本插件基于 sj244 的 dsh-qq-bridge（MIT）。
