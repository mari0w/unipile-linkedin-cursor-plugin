#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ProxyAgent } from "undici";
import { z } from "zod";

const MAX_LINKEDIN_ACCOUNTS = 10;
let cachedProxyUrl = null;
let proxyDispatcher = null;

export function resolveProxyUrl(env = process.env) {
  for (const name of [
    "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy",
    "ALL_PROXY", "all_proxy", "SAND_EGRESS_TUNNEL_PROXY_ADDR",
  ]) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return null;
}

export function shouldBypassProxy(destination, env = process.env) {
  const bypassList = env.NO_PROXY?.trim() || env.no_proxy?.trim() || "";
  const url = new URL(destination);
  const host = url.hostname.toLowerCase();
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return bypassList.split(",").some((entry) => {
    const rule = entry.trim().toLowerCase();
    if (rule === "*") return true;
    // Optional port, including bracketed IPv6 hosts.
    const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(rule);
    if (!match || (match[2] && match[2] !== port)) return false;
    const domain = match[1].replace(/^\*?\./, "");
    return host === domain || host.endsWith(`.${domain}`);
  });
}

export function getProxyDispatcher(destination) {
  if (destination && shouldBypassProxy(destination)) return null;
  const proxyUrl = resolveProxyUrl();
  if (proxyUrl !== cachedProxyUrl) {
    const nextDispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : null;
    // Drain the old agent without blocking requests that use the new setting.
    proxyDispatcher?.close().catch(() => {});
    proxyDispatcher = nextDispatcher;
    cachedProxyUrl = proxyUrl;
  }
  return proxyDispatcher;
}

export function baseUrl(dsn) {
  const value = dsn.trim().replace(/\/+$/, "").replace(/\/api\/v1$/i, "");
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

function errorMessage(error, apiKey = process.env.UNIPILE_API_KEY?.trim()) {
  const message = error instanceof Error ? error.message : String(error);
  return apiKey ? message.split(apiKey).join("[REDACTED]") : message;
}

export async function unipileRequest(path, { method = "GET", query = {}, body } = {}) {
  const apiKey = process.env.UNIPILE_API_KEY?.trim();
  const dsn = process.env.UNIPILE_DSN;
  if (!apiKey || !dsn?.trim()) {
    throw new Error(
      "Missing UNIPILE_API_KEY / UNIPILE_DSN. Set them in the plugin Configure or MCP env."
    );
  }

  try {
    const url = new URL(`${baseUrl(dsn)}/api/v1${path}`);
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(query)) {
      if (value !== undefined) params.set(name, String(value));
    }
    url.search = params.toString();
    const headers = { "X-API-KEY": apiKey, accept: "application/json" };
    if (body !== undefined && !(body instanceof FormData)) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(body);
    }
    const dispatcher = getProxyDispatcher(url);
    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(30000),
      ...(dispatcher ? { dispatcher } : {}),
    });
    if (!response.ok) {
      const body = errorMessage(await response.text(), apiKey).slice(0, 500);
      throw new Error(`Unipile HTTP ${response.status}: ${body}`);
    }
    return await response.json();
  } catch (error) {
    throw new Error(errorMessage(error, apiKey));
  }
}

const limit = z.number().int().min(1).max(250).optional();
const utcTime = z.string().datetime().optional();
const maxPages = z.number().int().min(1).max(10).default(3);
const accountId = z.string().min(1).describe("领英账号 ID。来自 list_accounts 的 account_id。");

export function parseLinkedinPublicId(profile) {
  const invalid = () => new Error("profile 无效。请输入 linkedin.com/in/{slug} 个人主页链接或公开 ID（slug）。");
  if (typeof profile !== "string") throw invalid();
  const value = profile.trim();
  const match = /^(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/([^/?#]+)\/?(?:[?#].*)?$/i.exec(value);
  let publicId;
  try {
    publicId = decodeURIComponent(match ? match[1] : value);
  } catch {
    throw invalid();
  }
  if (!/^[\p{L}\p{N}\p{M}_-]+$/u.test(publicId)) throw invalid();
  return publicId;
}

async function requireLinkedin(account_id) {
  const account = await unipileRequest(`/accounts/${encodeURIComponent(account_id)}`);
  if (account.type !== "LINKEDIN") {
    throw new Error(`account ${account_id} is not a LinkedIn account. This plugin supports LinkedIn only.`);
  }
}

async function getChatMessages({ chat_id, account_id, ...query }) {
  const result = await unipileRequest(`/chats/${encodeURIComponent(chat_id)}/messages`, { query });
  if (result.items.some((message) => message.account_id !== account_id)) {
    throw new Error(`chat does not belong to account ${account_id}`);
  }
  return result;
}

export async function searchMessages({ query, chat_id, account_id, before, after, max_pages }) {
  accountId.parse(account_id);
  const pages = maxPages.parse(max_pages);
  await requireLinkedin(account_id);
  const keyword = query.toLowerCase();
  const matches = [];
  let scanned = 0;
  let cursor;
  for (let page = 0; page < pages; page++) {
    const filters = { before, after, cursor, limit: 100 };
    const result = chat_id === undefined
      ? await unipileRequest("/messages", { query: { account_id, ...filters } })
      : await getChatMessages({ chat_id, account_id, ...filters });
    scanned += result.items.length;
    matches.push(...result.items.filter(
      (message) => typeof message.text === "string" && message.text.toLowerCase().includes(keyword)
    ));
    cursor = result.cursor;
    if (cursor == null) break;
  }
  return { matches, scanned, cursor: cursor ?? null };
}

function textResult(obj) {
  return {
    content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
  };
}

function errorResult(error) {
  return {
    content: [{ type: "text", text: `Error: ${errorMessage(error)}` }],
    isError: true,
  };
}

export function createServer() {
  const server = new McpServer({ name: "unipile-linkedin", version: "1.0.0" });

  server.tool(
    "list_accounts",
    "只支持领英账号。不支持其他平台。只返回本页的领英账号。字段为 account_id、type 和 name。其他工具使用这里的 account_id 指定账号。可用 account_id 在本页结果中筛选账号。用 cursor 读取下一页。",
    { account_id: accountId.optional(), cursor: z.string().optional(), limit },
    async ({ account_id, ...query }) => {
      try {
        const result = await unipileRequest("/accounts", { query });
        const items = result.items
          .filter((item) => item.type === "LINKEDIN" && (account_id === undefined || item.id === account_id))
          .map((item) => ({ account_id: item.id, type: item.type, name: item.name }));
        return textResult({ items, cursor: result.cursor ?? null });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.tool(
    "list_chats",
    "只支持领英账号。不支持其他平台。列出指定账号的对话。account_id 必填，来自 list_accounts。先查询账号类型。查询固定使用 account_type=LINKEDIN。可按未读状态或 UTC 时间筛选。用 cursor 读取下一页。",
    {
      account_id: accountId,
      unread: z.boolean().optional(),
      before: utcTime,
      after: utcTime,
      cursor: z.string().optional(),
      limit,
    },
    async (args) => {
      try {
        await requireLinkedin(args.account_id);
        return textResult(await unipileRequest("/chats", { query: { ...args, account_type: "LINKEDIN" } }));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.tool(
    "get_chat_messages",
    "只支持领英账号。不支持其他平台。读取一个对话的消息。account_id 必填，来自 list_accounts。先查询账号类型。工具校验每条消息的 account_id。任一消息不属于该账号时返回错误。可按发送者或 UTC 时间筛选。用 cursor 读取下一页。",
    {
      chat_id: z.string().min(1),
      account_id: accountId,
      cursor: z.string().optional(),
      limit,
      before: utcTime,
      after: utcTime,
      sender_id: z.string().optional(),
    },
    async (args) => {
      try {
        await requireLinkedin(args.account_id);
        return textResult(await getChatMessages(args));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.tool(
    "search_messages",
    "只支持领英账号。不支持其他平台。在本地搜索消息正文。匹配不区分大小写。account_id 必填，来自 list_accounts。先查询账号类型。有 chat_id 时只读取该对话。工具校验每条消息属于该账号。否则用 account_id 筛选 /messages。每页最多读取 100 条消息。max_pages 默认为 3。max_pages 最大为 10。搜索只覆盖最近 max_pages*100 条消息。返回 matches、scanned 和下一页 cursor。",
    {
      query: z.string().min(1),
      chat_id: z.string().min(1).optional(),
      account_id: accountId,
      before: utcTime,
      after: utcTime,
      max_pages: maxPages,
    },
    async (args) => {
      try {
        return textResult(await searchMessages(args));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.tool(
    "send_message",
    "只支持领英账号。不支持其他平台。在已有对话中发送文本消息。account_id 必填，来自 list_accounts。消息会以你本人的领英账号发出。对方会看到消息。默认只返回预览。预览不发送任何请求。发送前必须向用户展示收件对话和消息全文。用户明确确认后才传 confirm=true。confirm=true 时先查询账号类型，再发送消息。",
    {
      chat_id: z.string().min(1),
      text: z.string().min(1),
      account_id: accountId,
      confirm: z.boolean().default(false),
    },
    async ({ chat_id, text, account_id, confirm }) => {
      try {
        if (confirm !== true) {
          return textResult({
            sent: false,
            preview: { chat_id, account_id, text },
            notice: "该消息将以你本人的身份发出。确认后用 confirm=true 再次调用。",
          });
        }
        await requireLinkedin(account_id);
        const body = new FormData();
        body.set("text", text);
        body.set("account_id", account_id);
        return textResult(await unipileRequest(`/chats/${encodeURIComponent(chat_id)}/messages`, {
          method: "POST", body,
        }));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.tool(
    "start_chat_by_profile",
    "只支持领英账号。不支持其他平台。用个人主页链接或公开 ID（slug）发起对话并发送文本。account_id 必填，来自 list_accounts。消息以用户本人领英身份发出。非 Connections（非好友）可能失败。本工具不做 InMail。默认只返回预览。预览不发送任何请求。发送前必须向用户展示收件人的公开 ID、所选账号和消息全文。用户明确确认后才传 confirm=true。只有 confirm=true 才请求。先查询账号类型，再查询收件人的 provider_id，最后创建对话并发送消息。",
    {
      profile: z.string().min(1),
      text: z.string().min(1),
      account_id: accountId,
      confirm: z.boolean().default(false),
    },
    async ({ profile, text, account_id, confirm }) => {
      try {
        const public_id = parseLinkedinPublicId(profile);
        if (confirm !== true) {
          return textResult({
            sent: false,
            preview: { public_id, account_id, text },
            notice: "消息将以你本人的领英身份发出。非好友可能发不出去。本工具不做 InMail。确认后用 confirm=true 再次调用。",
          });
        }
        await requireLinkedin(account_id);
        const user = await unipileRequest(`/users/${encodeURIComponent(public_id)}`, { query: { account_id } });
        if (typeof user.provider_id !== "string" || !user.provider_id.trim()) {
          throw new Error("收件人查询未返回有效的 provider_id。未发送消息。");
        }
        const body = new FormData();
        body.set("attendees_ids", user.provider_id);
        body.set("text", text);
        body.set("account_id", account_id);
        return textResult(await unipileRequest("/chats", { method: "POST", body }));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.tool(
    "create_hosted_auth_link",
    "只支持领英账号。不支持其他平台。生成领英账号的临时接入链接。新建时 providers 固定为 [\"LINKEDIN\"]。最多接入 10 个领英账号。新建前分页统计全部领英账号。达到上限时工具报错。重新接入时传 account_id，其值来自 list_accounts。重连前先查询账号类型。重连不检查账号数量。expires_in_minutes 默认为 60。范围为 1 到 1440。把返回的 url 作为可点击链接发给用户。用户可直接在浏览器打开此链接完成领英登录。链接不要公开分享。所有链接在 Unipile 每日重启时失效。",
    {
      account_id: accountId.optional(),
      expires_in_minutes: z.number().int().min(1).max(1440).default(60),
      name: z.string().optional(),
    },
    async ({ account_id, expires_in_minutes, name }) => {
      try {
        if (account_id === undefined) {
          let count = 0;
          let cursor;
          do {
            const result = await unipileRequest("/accounts", { query: { limit: 250, cursor } });
            count += result.items.filter((item) => item.type === "LINKEDIN").length;
            cursor = result.cursor;
          } while (cursor);
          if (count >= MAX_LINKEDIN_ACCOUNTS) {
            throw new Error("已达 10 个领英账号上限，不能生成新的接入链接。");
          }
        } else {
          await requireLinkedin(account_id);
        }
        const body = {
          type: account_id === undefined ? "create" : "reconnect",
          ...(account_id === undefined ? { providers: ["LINKEDIN"] } : { reconnect_account: account_id }),
          api_url: baseUrl(process.env.UNIPILE_DSN ?? ""),
          expiresOn: new Date(Date.now() + expires_in_minutes * 60000).toISOString(),
          name,
        };
        return textResult(await unipileRequest("/hosted/accounts/link", { method: "POST", body }));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  return server;
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  process.on("unhandledRejection", (error) => console.error(errorMessage(error)));
  process.on("uncaughtException", (error) => console.error(errorMessage(error)));
  await createServer().connect(new StdioServerTransport());
}
