---
name: unipile-linkedin
description: >-
  只支持领英账号。
  不支持其他平台。
  通过 Unipile 读取多个领英账号的消息。
  用于汇总消息、收集需求和搜索正文。
  可用领英个人主页链接发起新对话。
  可用 create_post 发布领英动态。
  优先使用 unipile-linkedin MCP 工具。
  发送前必须获得用户确认。
  批量发送前先读频率准则并提醒用户。
  支持生成临时账号接入链接。
  最多接入 10 个领英账号。
---

# Unipile LinkedIn

## 流程

1. 调用 `list_accounts`。
2. 选择所需账号的 `account_id`。
3. 调用 `list_chats` 时传入该 `account_id`。
4. 工具固定使用 `account_type=LINKEDIN`。
5. 找到所需对话的 `chat_id`。
6. 调用 `get_chat_messages` 时传入 `chat_id` 和同一 `account_id`。
7. 工具会校验每条消息属于该账号。
8. 校验失败时，停止读取该对话。
9. 使用响应中的 `cursor` 读取下一页。
10. `cursor` 为 `null` 时停止翻页。

一个 API Key 可接入多个领英账号。
本插件最多接入 10 个领英账号。
`list_accounts` 只返回本页的领英账号。
读取、搜索、发送和按主页开聊时必须指定 `account_id`。
`account_id` 来自 `list_accounts`。
向 `list_accounts` 传入 `account_id` 时，只筛选本页结果。
读取对话、读取消息和搜索消息前，工具先查询账号类型。
确认发送和生成重连链接前，工具也先查询账号类型。
查询使用 `GET /api/v1/accounts/{account_id}`。
类型不是 `LINKEDIN` 时，工具报错。
此时工具不调用业务接口。
每次校验会增加一次 API 调用。
同一次搜索只校验一次账号类型。

## 搜索

- 使用 `search_messages` 搜索消息正文。
- 必须传入所选账号的 `account_id`。
- 搜索是本地过滤。
- Unipile 没有服务端的消息全文搜索接口。
- 工具只匹配消息的 `text` 字段。
- 匹配不区分大小写。
- 每页最多读取 100 条消息。
- `max_pages` 默认为 3。
- `max_pages` 最大为 10。
- 搜索只覆盖最近 `max_pages*100` 条消息。
- 提供 `chat_id` 时只搜索该对话。
- 此时工具校验每页的全部消息属于该账号。
- 任一消息不属于该账号时，工具不返回数据。
- 未提供 `chat_id` 时用 `account_id` 限定账号。
- 用 `before` 和 `after` 限定时间。
- 时间必须使用 ISO 8601 UTC 格式。
- `matches` 是匹配的消息。
- `scanned` 是已读取的消息数量。
- `cursor` 是未读完时的下一页游标。
- 有下一页游标时，说明搜索没有覆盖全部消息。
- 汇总结果时说明搜索范围。

## 发送规则

已有对话时，使用 `send_message`。
只有领英个人主页或公开 ID、没有 `chat_id` 时，使用 `start_chat_by_profile`。
两种工具都默认只返回预览。
用户明确确认后，才传 `confirm=true`。

### 已有对话：`send_message`

1. 先不带 `confirm` 调用 `send_message` 获取预览。
2. 调用时传入 `chat_id`、`account_id` 和非空的 `text`。
3. 把收件对话展示给用户。
4. 把发送账号展示给用户。
5. 把消息全文展示给用户。
6. 说明消息会以用户本人的领英账号发出。
7. 说明对方会看到消息。
8. 用户明确同意后，才用同一参数和 `confirm=true` 发送。

### 按主页开聊：`start_chat_by_profile`

1. 先不带 `confirm` 调用 `start_chat_by_profile` 获取预览。
2. 调用时传入领英个人主页链接或公开 ID、`account_id` 和非空的 `text`。
3. 把解析出的公开 ID 展示给用户。
4. 把发送账号展示给用户。
5. 把消息全文展示给用户。
6. 说明消息会以用户本人的领英账号发出。
7. 说明非 Connections（非好友）可能发不出去。
8. 说明本工具不做 InMail。
9. 用户明确同意后，才用同一参数和 `confirm=true` 发送。
10. `confirm=true` 时，工具先校验账号类型，再查询收件人 `provider_id`，最后创建对话并发送文本。

默认调用不会发送任何请求。
`confirm=false` 时不会发送任何请求。
预览不发送账号查询请求。
`confirm=true` 时，工具先查询账号类型。
批量发送前，先读下方频率准则并提醒用户。
不要替用户自动回复。
控制领英发送频率。

## 领英发送频率使用准则

来源：[Unipile 平台限制文档](https://developer.unipile.com/docs/provider-limits-and-restrictions)。
以下用量是 Unipile 的 conservative recommendations（保守建议）。
这些建议不保证领英账号不会受限。
插件只提醒。
插件不按这些建议硬性拦截。
插件不设置每日发送上限。
发送仍需用户明确确认。
只有确认后才传 `confirm=true`。

| 操作 | Unipile 保守建议或文档说明 |
| --- | --- |
| 给好友发消息 | 属于 Other Routes。每个账号每天约 100 条。 |
| 付费号发邀请 | 每天 80–100 个。每周约 200 个。留言最多 300 字符。 |
| 免费号发带留言邀请 | 每月约 5 个。留言最多 200 字符。 |
| 免费号发不带留言邀请 | 每周约 150 个。 |
| 查看主页 | 每天约 100 个。 |
| 领英搜索的单次查询 | 标准账号最多返回 1000 条。Sales Navigator / Recruiter 最多返回 2500 条。Sales Navigator 公司搜索最多返回 1000 条。 |
| 领英搜索的每日合计 | 标准账号建议 1000 条。Sales Navigator / Recruiter 建议 2500 条。按当天实际取回的结果行合计。不是按请求次数计算。 |
| InMail | 建议每天 30–50 条。月额度取决于订阅。Open Profile 免费 InMail 另有每月上限。以 LinkedIn UI 为准。 |
| 读取消息和对话 | 不受上述用量限制。Unipile 在服务端同步。 |

领英搜索指主页搜索。
本插件的 `search_messages` 是本地消息搜索。
本插件不提供邀请、主页搜索或 InMail 工具。

- 额度按每个领英账号计算。
- 多个 bot 共用同一账号时，额度共享。
- 发送数量要包括该账号由其他 bot 和用户发送的数量。
- 发送间隔要随机。
- 不要使用固定间隔。
- 在工作时间分几次发送。
- 新号或久未使用的号先少量发送。
- 再逐步增加数量。
- 好友少于约 150 的账号发邀请容易出问题。

### 何时必须主动提醒用户

- 用户要批量打招呼、发消息或加好友。
- 用户要开多个 bot 用同一账号发送。
- 用户要在短时间内大量发送。

先说明对应操作的数量建议。
再说明间隔建议。
用普通人能懂的话。
例如：“给好友发消息，每个账号每天约 100 条。把发送分到工作时间的几次操作中。每条消息之间留出随机间隔。不要按固定间隔连续发送。多个 bot 共用账号时，发送数量合并计算。”
发邀请时，按账号类型说明每日、每周或每月的建议。
发带留言邀请时，说明留言字符数。
不要把每日建议当作每日可用余额。
不要仅因计划数量超过建议就拒绝发送。

### 超限错误

超限时可能返回 HTTP 429 或 500。
邀请超限时可能返回 HTTP 422，正文含 `cannot_resend_yet`。
遇到这些错误时，停止发送。
说明这可能触发了领英限制。
稍后再试。
不要连续重试。

## 发领英动态：`create_post`

1. 先不带 `confirm` 调用 `create_post` 获取预览。
2. 传入 `account_id` 和 `text`。
3. 把发送账号、动态全文和所选参数展示给用户。
4. 说明动态会以用户本人的领英账号发出。提供 `as_organization` 时，以所选公司主页发出。
5. 用户明确同意后，才用同一参数和 `confirm=true` 发布。

默认预览不发送任何请求。
确认后先校验领英账号，再发布动态。
可选参数为 `mentions`、`external_link`、`repost` 和 `as_organization`。
`mentions` 每项包含 `name`、`profile_id` 和可选的 `is_company`。
在 `text` 中用 `{{0}}` 等索引对应 `mentions` 数组。
`external_link` 必须以 `http://` 或 `https://` 开头。
无评论转发时，传入 `repost` 和 `text: ""`。
空文本只用于无评论转发。
本版不支持附件。
按 Unipile 保守建议，每个领英账号每天发帖建议不超过约 100 次。
发送间隔要随机。
多个 bot 共用同一账号时额度共享。
向用户展示工具返回的 `rate_reminder`。
工具不实施硬限流。

## 接入账号

接入新账号时，调用 `create_hosted_auth_link`。
不需要传入参数。
工具使用 `type: "create"`。
工具固定发送 `providers: ["LINKEDIN"]`。
生成新链接前，工具按 `cursor` 查询全部账号页。
每页固定使用 `limit=250`。
`cursor` 为空时停止翻页。
工具只统计 `type` 为 `LINKEDIN` 的账号。
这会增加账号列表 API 调用。
最多接入 10 个领英账号。
已有领英账号数量达到 10 个时，工具报错。
错误内容为：“已达 10 个领英账号上限，不能生成新的接入链接。”
此时工具不发送生成链接的请求。
重新接入时，传入来自 `list_accounts` 的 `account_id`。
工具使用 `type: "reconnect"`。
工具把 `account_id` 传入 `reconnect_account`。
工具先查询账号类型。
只有领英账号可以重连。
重连不新增账号。
重连不检查账号数量。
`expires_in_minutes` 默认为 60。
范围为 1 到 1440。
`name` 可选。
工具原样传递 `name`。
链接是临时的。
链接只给本人。
返回的 `url` 是可直接在浏览器打开的领英登录链接。
把返回的 `url` 作为可点击链接发给用户。
让本人在浏览器打开链接完成登录。
链接不要公开分享。
所有链接在 Unipile 每日重启时失效。
完成登录后，再调用 `list_accounts` 查询账号。

## DSN 和代理

用户仍只需配置 DSN 和 API Key。
DSN 可保留原端口。
DSN 带非协议默认端口时，插件自动通过 HTTPS 443 请求。
每个请求都带查询参数 `port=<原端口>`。
插件保留其他查询参数。
DSN 无端口或使用协议默认端口时，插件保留原协议。
此时插件不额外加入 `port`。
443 失败时，插件不回退到原端口。
非常用端口场景优先使用插件的 443 和 `port` 方式。
插件仍支持 `HTTPS_PROXY`、`HTTP_PROXY`、`ALL_PROXY` 和 `SAND_EGRESS_TUNNEL_PROXY_ADDR`。
`NO_PROXY` 按实际请求地址匹配。
改写后的实际请求端口是 443。

## 安全

- 控制调用频率，保护领英账号。
- 遇到 HTTP 429 或 500 时停止调用。
- 遇到 HTTP 422 且正文含 `cannot_resend_yet` 时停止发送。
- 稍后再试。
- 本插件不能修改或删除消息。
- 不要把 API Key 贴到聊天。
- 认证失败时，请用户更新插件 Configure 中的变量。
