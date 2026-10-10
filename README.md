# Unipile LinkedIn 插件

## 简介

本插件通过 Unipile 在 Cursor / Grok Bot 读取领英（LinkedIn）消息。
本插件只支持领英账号。
本插件不支持 Telegram 或其他平台。
本插件最多接入 10 个领英账号。
本插件以读取为主，另有两个发送工具。
你可以用它汇总消息。
你也可以用它收集需求。
你也可以用它生成账号接入链接。
本插件不修改或删除消息。

## 工具表

| 名称 | 说明 | Unipile 接口 |
| --- | --- | --- |
| `list_accounts` | 只列出本页领英账号的 `account_id`、`type` 和 `name` | `GET /api/v1/accounts` |
| `list_chats` | 列出指定领英账号的对话，支持未读状态和时间筛选 | `GET /api/v1/chats` |
| `get_chat_messages` | 读取领英对话消息，校验消息归属，支持发送者和时间筛选 | `GET /api/v1/chats/{chat_id}/messages` |
| `search_messages` | 分页读取领英消息，在本地匹配正文关键字 | 有 `chat_id` 时使用 `GET /api/v1/chats/{chat_id}/messages`；否则使用 `GET /api/v1/messages` |
| `send_message` | 默认返回预览，用户确认后发送领英文本消息 | `POST /api/v1/chats/{chat_id}/messages` |
| `start_chat_by_profile` | 用个人主页链接或公开 ID 发起对话。默认只预览。确认后发送。不做 InMail | `GET /api/v1/users/{identifier}`，再用 `POST /api/v1/chats` |
| `create_hosted_auth_link` | 生成领英账号接入或重连链接，新建受 10 个账号上限限制 | `POST /api/v1/hosted/accounts/link` |

所有工具只支持领英账号。
读取对话、读取消息和搜索消息前，工具先查询账号类型。
确认发送和生成重连链接前，工具也先查询账号类型。
查询使用 `GET /api/v1/accounts/{account_id}`。
账号类型必须为 `LINKEDIN`。
类型不符时，工具报错。
此时工具不调用业务接口。
每次类型校验会多一次 API 调用。
同一次搜索只校验一次账号类型。
发送预览不查询账号类型。
参见 [Retrieve an account 接口](https://developer.unipile.com/reference/accountscontroller_getaccountbyid)。

`list_chats` 固定传入 `account_type=LINKEDIN`。
`list_chats` 同时传入所选账号的 `account_id`。
调用方不需要提供 `account_type`。

列表接口使用 `cursor` 翻页。
响应中的 `cursor` 为 `null` 时没有更多数据。
`limit` 的范围为 1 到 250。
未提供的查询参数不会发送。
`before` 和 `after` 使用 ISO 8601 UTC 格式。
例如：`2026-10-01T00:00:00Z`。

`search_messages` 是本地过滤。
Unipile 没有服务端的消息全文搜索接口。
工具对消息的 `text` 字段做包含匹配。
匹配不区分大小写。
每页最多读取 100 条消息。
`max_pages` 默认为 3。
`max_pages` 最大为 10。
搜索只覆盖最近 `max_pages*100` 条消息。
`account_id` 必填。
提供 `chat_id` 时，工具校验每页的全部消息属于该账号。
未提供 `chat_id` 时，工具按 `account_id` 筛选消息。
`matches` 是匹配的消息。
`scanned` 是已读取的消息数量。
`cursor` 是未读完时的下一页游标。
有下一页游标时，结果没有覆盖全部消息。

## 多账号

一个 API Key 可接入多个领英账号。
本插件最多接入 10 个领英账号。
先用 `list_accounts` 查询 `account_id`。
`list_accounts` 只返回本页中 `type` 为 `LINKEDIN` 的账号。
其他类型的账号会被过滤。
`type` 表示账号类型。
`name` 是账号名称。
向 `list_accounts` 传入 `account_id` 时，工具只在本页结果中筛选该账号。
工具不会为这个筛选自动读取其他页。
读取对话、读取消息、搜索消息和发送消息时都要传 `account_id`。
`get_chat_messages` 会校验对话属于该账号。
工具会检查返回的每条消息的 `account_id`。
任一消息不属于该账号时，工具返回错误。
此时工具不返回消息数据。
`search_messages` 按对话搜索时使用同一校验。
`send_message` 把 `account_id` 作为表单字段传给 Unipile。
Unipile 用它阻止在其他账号的对话中发送。

## 发送规则

消息以你本人的领英账号发出。
对方会看到消息。
工具默认只返回预览。
预览包含 `chat_id`、`account_id` 和消息全文。
助手先不带 `confirm` 调用 `send_message`。
助手向你展示收件对话和消息全文。
你明确确认后，助手才用 `confirm=true` 发送。
未传 `confirm` 时不会发送任何请求。
`confirm=false` 时也不会发送任何请求。
预览不发送账号查询请求。
`confirm=true` 时，工具先查询账号类型。
只有领英账号可以发送消息。
`send_message` 只能在已有对话里发送。
本版只支持文本消息。
本版不支持附件或语音。
不要批量发送。
不要替用户自动回复。
领英发送也受频率限制。
自动化发送可能触发账号限制。

## 用个人主页链接发起对话

用 `start_chat_by_profile` 向一个领英用户发送文本。
`profile`、`text` 和 `account_id` 必填。
`profile` 可用个人主页链接，例如 `https://www.linkedin.com/in/alice-smith-123/`。
链接可省略 `https://` 或 `www.`。
链接可带末尾的 `/` 和查询参数。
也可只传公开 ID，例如 `alice-smith-123`。
无效输入会返回错误。
`confirm` 默认为 `false`。
默认只返回预览，不发送任何 Unipile 请求。
预览包含解析后的公开 ID（`public_id`）、`account_id` 和消息全文。
消息以你本人的领英身份发出。
非好友（非 Connections）可能发不出去。
本工具不做 InMail。
助手先向你展示预览。
你明确确认后，助手才传入 `confirm=true`。
工具先查询账号类型。
工具再用公开 ID 和 `account_id` 查询收件人的 `provider_id`。
工具最后用表单发送 `attendees_ids`、`text` 和 `account_id`。
工具不设置 `linkedin[inmail]`。
参见 [创建对话接口](https://developer.unipile.com/reference/chatscontroller_startnewchat)。

## 前提

- 你需要一个 Unipile 账号。
- 你需要接入自己的领英账号才能读取或发送消息。
- 本地需要 Node.js 20 和 npm。

## 获取 DSN 和 API Key

1. 登录 [Unipile 控制台](https://dashboard.unipile.com)。
2. 在控制台首页复制 DSN。
3. 打开 [Access Tokens 页面](https://dashboard.unipile.com/access-tokens)。
4. 生成 Access Token。
5. 这个 Access Token 就是 API Key。

DSN 示例：`https://api1.unipile.com:13111`。
DSN 不需要包含 `/api/v1`。
DSN 未包含 `http://` 或 `https://` 时，插件自动补上 `https://`。
插件会去掉 DSN 末尾的 `/`。

## 接入账号

### 方法一：控制台

在控制台的 Accounts 页面直接接入账号。
选择领英。
按页面提示完成认证。
本插件生成新接入链接时，会统计控制台已接入的领英账号。

### 方法二：托管认证（Hosted Auth）

用 `create_hosted_auth_link` 生成临时链接。
返回的 `url` 是可直接在浏览器打开的领英登录链接。
助手把返回的 `url` 作为可点击链接发给你。
接入新账号时，不需要传入参数。
例如：`{}`。
工具使用 `type: "create"`。
工具固定发送 `providers: ["LINKEDIN"]`。
调用方不需要提供 `providers`。
生成新链接前，工具查询全部账号页。
查询使用 `GET /api/v1/accounts`。
每页固定使用 `limit=250`。
工具按 `cursor` 翻页。
`cursor` 为空时，工具停止翻页。
工具只统计 `type` 为 `LINKEDIN` 的账号。
这会增加账号列表 API 调用。
最多接入 10 个领英账号。
已有领英账号数量达到 10 个时，工具报错。
错误内容为：“已达 10 个领英账号上限，不能生成新的接入链接。”
此时工具不发送生成链接的请求。
把链接给本人在浏览器打开。
按页面提示完成领英登录。
链接不要公开分享。
`expires_in_minutes` 默认为 60。
范围为 1 到 1440。
所有链接在 Unipile 每日重启时失效。
`name` 可选。
工具原样传递 `name`。
重新接入时传入 `account_id`。
先用 `list_accounts` 查询该账号的 `account_id`。
例如：`{"account_id":"所需账号的 ID"}`。
工具使用 `type: "reconnect"`。
工具把 `account_id` 传入 `reconnect_account`。
工具先查询该账号的类型。
只有领英账号可以重连。
重连不新增账号。
重连不检查账号数量。
完成登录后，再用 `list_accounts` 查询账号。
参见 [Hosted Auth 文档](https://developer.unipile.com/docs/hosted-auth)。

领英支持账号密码、Cookie 等认证方式。
参见 [账号接入文档](https://developer.unipile.com/docs/connect-accounts)。

## 安装插件

克隆仓库：

```bash
git clone https://github.com/mari0w/unipile-linkedin-cursor-plugin.git ~/.cursor/plugins/local/unipile-linkedin
```

重载 Cursor。
打开 **Plugins → Unipile LinkedIn → Configure**。
填写以下变量：

| 变量 | 内容 |
| --- | --- |
| `UNIPILE_API_KEY` | 控制台生成的 Access Token |
| `UNIPILE_DSN` | 控制台首页显示的 DSN |

你也可以在本地手动设置环境变量：

```bash
export UNIPILE_API_KEY='你的 API Key'
export UNIPILE_DSN='https://api1.unipile.com:13111'
bash scripts/run-mcp.sh
```

手动启动时，请在仓库根目录运行脚本。
启动时，`run-mcp.sh` 检查 SDK、undici 和 zod。
缺少任一直接依赖时，脚本自动运行 `npm install`。
脚本通过 stdio 提供 MCP 服务。
MCP 客户端需要继承这两个环境变量。

DSN 可能使用非常用端口，例如 `19891`。
如果直连失败，请设置 `HTTPS_PROXY`。
也可设置 `HTTP_PROXY`、`ALL_PROXY` 或 `SAND_EGRESS_TUNNEL_PROXY_ADDR`。
代理地址必须包含 `http://` 或 `https://`。
例如：`export HTTPS_PROXY='http://127.0.0.1:8080'`。
MCP 服务进程需要继承代理环境变量。
插件按上述顺序选择第一个非空代理地址。
插件会去掉地址两端的空白。
前三个变量也支持小写名称。
同一变量优先使用大写名称。
未设置代理地址时，插件使用直连。
`NO_PROXY` 可指定直连的目标主机。
也可使用小写变量 `no_proxy`。
优先使用非空的大写值。
用逗号分隔多项规则。
规则支持主机名、域名后缀（例如 `.unipile.com`）和 `*`。
主机名规则也匹配其子域名。
`*` 表示所有目标都使用直连。
主机名可带端口，例如 `api1.unipile.com:13111`。
带端口的规则只匹配该端口。
规则不区分大小写。
命中规则时，插件不使用代理。

## 使用示例提问

- “列出我在 Unipile 接入的领英账号。”
- “列出我的领英未读对话。”
- “读取这个领英对话的最近消息。”
- “汇总昨天的领英消息，提取用户需求。”
- “在这个对话的最近 300 条消息中搜索 budget。”
- “生成一个领英账号接入链接。”
- “预览在这个对话中发送的消息：我已收到你的需求。”
- “预览向 https://www.linkedin.com/in/alice-smith-123/ 发送：你好，我想讨论你的需求。”

## 领英账号风险提示

自动化操作可能触发领英限制或封号。
只用你自己的真实账号。
控制调用频率。
不要在短时间内大量读取。
新账号或不活跃账号的风险更高。
领英超限时可能返回 HTTP 429 或 500。
遇到这些错误时停止调用。
稍后再试。
参见 [平台限制文档](https://developer.unipile.com/docs/provider-limits-and-restrictions)。

## 安全

API Key 有完整权限。
不要把 API Key 提交到仓库。
不要把 API Key 贴到聊天。
请在插件 Configure 或本地环境变量中设置 API Key。
`.env` 和 `node_modules/` 已在 `.gitignore` 中排除。

## 测试

在仓库根目录安装依赖：

```bash
npm install --prefix server
```

在仓库根目录运行测试：

```bash
cd server && npm test
```

测试使用本地 HTTP 服务。
测试不调用真实的 Unipile 账号。
stdio 测试会发送 `initialize` 和 `tools/list`。
测试会确认服务正好提供七个工具。

## 许可证

使用 [MIT 许可证](LICENSE)。
Copyright (c) 2026 Enoch Z。
