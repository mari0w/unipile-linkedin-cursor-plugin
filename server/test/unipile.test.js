import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ProxyAgent } from "undici";
import { baseUrl, createServer, getProxyDispatcher, resolveProxyUrl, searchMessages, unipileRequest } from "../index.js";

const before = "2026-10-10T00:00:00Z";
const after = "2026-10-01T00:00:00Z";
const emptyPage = { object: "List", items: [], cursor: null };
const unsupportedAccount = { id: "other-account", type: "TELEGRAM", name: "其他账号" }; // 不支持 Telegram：测试拒绝非领英账号。
const proxyEnvNames = [
  "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy",
  "ALL_PROXY", "all_proxy", "SAND_EGRESS_TUNNEL_PROXY_ADDR",
];

function clearProxyEnv(t) {
  const previous = Object.fromEntries(proxyEnvNames.map((name) => [name, process.env[name]]));
  for (const name of proxyEnvNames) delete process.env[name];
  getProxyDispatcher();
  t.after(() => {
    for (const name of proxyEnvNames) delete process.env[name];
    getProxyDispatcher();
    for (const [name, value] of Object.entries(previous)) {
      if (value !== undefined) process.env[name] = value;
    }
  });
}

async function mockApi(t, respond = () => emptyPage, account = { type: "LINKEDIN" }) {
  clearProxyEnv(t);
  const previousKey = process.env.UNIPILE_API_KEY;
  const previousDsn = process.env.UNIPILE_DSN;
  const requests = [];
  let page = 0;
  const mock = createHttpServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const request = {
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      apiKey: req.headers["x-api-key"],
      accept: req.headers.accept,
    };
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.headers["content-type"]) request.contentType = req.headers["content-type"];
    if (chunks.length) request.body = Buffer.concat(chunks).toString();
    requests.push(request);
    const response = request.path.startsWith("/api/v1/accounts/") ? account : respond(request, ++page);
    res.writeHead(response.status ?? 200, { "content-type": "application/json" });
    res.end(response.body ?? JSON.stringify(response));
  });
  await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
  process.env.UNIPILE_DSN = `http://127.0.0.1:${mock.address().port}`;
  process.env.UNIPILE_API_KEY = "test-key";
  t.after(async () => {
    if (previousKey === undefined) delete process.env.UNIPILE_API_KEY;
    else process.env.UNIPILE_API_KEY = previousKey;
    if (previousDsn === undefined) delete process.env.UNIPILE_DSN;
    else process.env.UNIPILE_DSN = previousDsn;
    mock.closeAllConnections();
    await new Promise((resolve, reject) => mock.close((error) => error ? reject(error) : resolve()));
  });
  return requests;
}

async function connectClient(t) {
  const server = createServer();
  const client = new Client({ name: "unipile-linkedin-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

async function callTool(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, result.content[0].text);
  assert.equal(result.content[0].type, "text");
  return JSON.parse(result.content[0].text);
}

function assertRequest(request, path, query) {
  assert.deepEqual(request, {
    method: "GET",
    path,
    query,
    apiKey: "test-key",
    accept: "application/json",
  });
}

test("list_accounts filters this page to LinkedIn accounts and returns only account_id, type, and name", async (t) => {
  const page = {
    object: "AccountList",
    items: [
      { id: "account-1", type: "LINKEDIN", name: "领英账号", extra: { connected: true } },
      { id: "account-2", type: "LINKEDIN", name: "第二个领英账号", extra: "omitted" },
      unsupportedAccount,
      { id: "lowercase", type: "linkedin", name: "小写类型" },
    ],
    cursor: "next-account",
  };
  const requests = await mockApi(t, () => page);
  const client = await connectClient(t);
  assert.deepEqual(await callTool(client, "list_accounts", { cursor: "a+/=?&", limit: 250 }), {
    items: [
      { account_id: "account-1", type: "LINKEDIN", name: "领英账号" },
      { account_id: "account-2", type: "LINKEDIN", name: "第二个领英账号" },
    ],
    cursor: "next-account",
  });
  assertRequest(requests[0], "/api/v1/accounts", { cursor: "a+/=?&", limit: "250" });
  assert.deepEqual(await callTool(client, "list_accounts", { account_id: "account-2", cursor: "page-2", limit: 1 }), {
    items: [{ account_id: "account-2", type: "LINKEDIN", name: "第二个领英账号" }],
    cursor: "next-account",
  });
  assertRequest(requests[1], "/api/v1/accounts", { cursor: "page-2", limit: "1" });
  assert.deepEqual(await callTool(client, "list_accounts", { account_id: "absent" }), {
    items: [], cursor: "next-account",
  });
  assertRequest(requests[2], "/api/v1/accounts", {});
  assert.deepEqual(await callTool(client, "list_accounts", { account_id: unsupportedAccount.id }), {
    items: [], cursor: "next-account",
  });
  assertRequest(requests[3], "/api/v1/accounts", {});
  assert.equal(requests.length, 4);
});

test("list_chats passes every filter, including unread false", async (t) => {
  const requests = await mockApi(t);
  const client = await connectClient(t);
  const args = {
    account_id: "account/a ?#% 中文",
    unread: false,
    before,
    after,
    cursor: "next-chat",
    limit: 1,
  };
  assert.deepEqual(await callTool(client, "list_chats", args), emptyPage);
  assert.equal(requests.length, 2);
  assertRequest(requests[0], `/api/v1/accounts/${encodeURIComponent(args.account_id)}`, {});
  assertRequest(requests[1], "/api/v1/chats", { ...args, account_type: "LINKEDIN", unread: "false", limit: "1" });
});

test("get_chat_messages encodes chat_id and passes all message filters", async (t) => {
  const requests = await mockApi(t);
  const client = await connectClient(t);
  const chat_id = "team/a ?#% 中文";
  const args = { chat_id, account_id: "account-1", cursor: "message+/=", limit: 30, before, after, sender_id: "sender & 1" };
  assert.deepEqual(await callTool(client, "get_chat_messages", args), emptyPage);
  assert.equal(requests.length, 2);
  assertRequest(requests[0], "/api/v1/accounts/account-1", {});
  assertRequest(requests[1], `/api/v1/chats/${encodeURIComponent(chat_id)}/messages`, {
    cursor: "message+/=", limit: "30", before, after, sender_id: "sender & 1",
  });
});

test("get_chat_messages returns messages when every account_id matches", async (t) => {
  const page = {
    items: [
      { id: "1", account_id: "account-1", text: "领英消息" },
      { id: "2", account_id: "account-1", text: "LinkedIn message" },
    ],
    cursor: "next-message",
  };
  const requests = await mockApi(t, () => page);
  const client = await connectClient(t);
  assert.deepEqual(await callTool(client, "get_chat_messages", {
    chat_id: "chat-1", account_id: "account-1",
  }), page);
  assert.equal(requests.length, 2);
  assertRequest(requests[0], "/api/v1/accounts/account-1", {});
  assertRequest(requests[1], "/api/v1/chats/chat-1/messages", {});
});

test("get_chat_messages rejects the whole page if any message has a different or missing account_id", async (t) => {
  let messageAccount;
  const requests = await mockApi(t, () => ({
    items: [
      { id: "1", account_id: "account-1", text: "private matching message" },
      { id: "2", account_id: messageAccount, text: "private mismatched message" },
    ],
    cursor: null,
  }));
  const client = await connectClient(t);
  for (messageAccount of ["account-2", undefined]) {
    assert.deepEqual(await client.callTool({
      name: "get_chat_messages", arguments: { chat_id: "chat-1", account_id: "account-1" },
    }), {
      content: [{ type: "text", text: "Error: chat does not belong to account account-1" }],
      isError: true,
    });
  }
  assert.equal(requests.length, 4);
  assertRequest(requests[0], "/api/v1/accounts/account-1", {});
  assertRequest(requests[2], "/api/v1/accounts/account-1", {});
});

test("list and message tools omit all optional query parameters", async (t) => {
  const requests = await mockApi(t);
  const client = await connectClient(t);
  await callTool(client, "list_accounts");
  await callTool(client, "list_chats", { account_id: "account-1" });
  await callTool(client, "get_chat_messages", { chat_id: "chat-1", account_id: "account-1" });
  assert.equal(requests.length, 5);
  assertRequest(requests[0], "/api/v1/accounts", {});
  assertRequest(requests[1], "/api/v1/accounts/account-1", {});
  assertRequest(requests[2], "/api/v1/chats", { account_id: "account-1", account_type: "LINKEDIN" });
  assertRequest(requests[3], "/api/v1/accounts/account-1", {});
  assertRequest(requests[4], "/api/v1/chats/chat-1/messages", {});
});

test("search_messages reads two pages and matches text without case sensitivity", async (t) => {
  const first = [
    { id: "1", text: "Budget review", extra: true },
    { id: "2", text: "other" },
    { id: "3", subject: "budget", text: null },
  ];
  const second = [
    { id: "4", text: "Annual BUDGET confirmed" },
    { id: "5", text: "budgeting" },
    { id: "6", text: 123 },
  ];
  const requests = await mockApi(t, ({ query }) => ({
    object: "MessageList",
    items: query.cursor ? second : first,
    cursor: query.cursor ? null : "page+/=2",
  }));
  const client = await connectClient(t);
  const result = await callTool(client, "search_messages", { query: "bUdGeT", account_id: "account-1", before, after });
  assert.deepEqual(result, { matches: [first[0], second[0], second[1]], scanned: 6, cursor: null });
  assert.equal(requests.length, 3);
  assertRequest(requests[0], "/api/v1/accounts/account-1", {});
  assertRequest(requests[1], "/api/v1/messages", { account_id: "account-1", before, after, limit: "100" });
  assertRequest(requests[2], "/api/v1/messages", { account_id: "account-1", before, after, cursor: "page+/=2", limit: "100" });
});

test("search_messages uses the encoded chat path and validates account_id on every page", async (t) => {
  const requests = await mockApi(t, (_, page) => ({
    object: "MessageList", items: [{ id: String(page), text: "LinkedIn NEED", account_id: "account-1" }], cursor: page === 1 ? "chat-page-2" : null,
  }));
  const client = await connectClient(t);
  const chat_id = "chat/a ?#% 中文";
  const result = await callTool(client, "search_messages", {
    query: "need", chat_id, account_id: "account-1", before, after,
  });
  assert.equal(result.scanned, 2);
  assert.equal(result.matches.length, 2);
  assert.equal(result.cursor, null);
  assert.equal(requests.length, 3);
  const path = `/api/v1/chats/${encodeURIComponent(chat_id)}/messages`;
  assertRequest(requests[0], "/api/v1/accounts/account-1", {});
  assertRequest(requests[1], path, { before, after, limit: "100" });
  assertRequest(requests[2], path, { before, after, cursor: "chat-page-2", limit: "100" });
});

test("search_messages rejects a later mismatched page before filtering or returning earlier matches", async (t) => {
  const requests = await mockApi(t, (_, page) => ({
    items: [{ id: String(page), text: page === 1 ? "match" : "unrelated", account_id: page === 1 ? "account-1" : "account-2" }],
    cursor: `page-${page + 1}`,
  }));
  const client = await connectClient(t);
  assert.deepEqual(await client.callTool({
    name: "search_messages", arguments: { query: "match", chat_id: "chat-1", account_id: "account-1" },
  }), {
    content: [{ type: "text", text: "Error: chat does not belong to account account-1" }],
    isError: true,
  });
  assert.equal(requests.length, 3);
  assertRequest(requests[0], "/api/v1/accounts/account-1", {});
  assertRequest(requests[1], "/api/v1/chats/chat-1/messages", { limit: "100" });
  assertRequest(requests[2], "/api/v1/chats/chat-1/messages", { cursor: "page-2", limit: "100" });
});

test("searchMessages returns the next cursor when max_pages stops the scan", async (t) => {
  const requests = await mockApi(t, () => ({ items: [{ id: "1", text: "match" }], cursor: "unread-page" }));
  assert.deepEqual(await searchMessages({ query: "match", account_id: "account-1", max_pages: 1 }), {
    matches: [{ id: "1", text: "match" }], scanned: 1, cursor: "unread-page",
  });
  assert.equal(requests.length, 2);
  assertRequest(requests[0], "/api/v1/accounts/account-1", {});
  assertRequest(requests[1], "/api/v1/messages", { account_id: "account-1", limit: "100" });
});

test("search_messages defaults to three pages", async (t) => {
  const requests = await mockApi(t, (_, page) => ({
    items: Array.from({ length: 100 }, (_, item) => ({ id: `${page}-${item}`, text: "other" })),
    cursor: `page-${page + 1}`,
  }));
  const client = await connectClient(t);
  assert.deepEqual(await callTool(client, "search_messages", { query: "absent", account_id: "account-1" }), {
    matches: [], scanned: 300, cursor: "page-4",
  });
  assert.equal(requests.length, 4);
  assertRequest(requests[0], "/api/v1/accounts/account-1", {});
  assertRequest(requests[1], "/api/v1/messages", { account_id: "account-1", limit: "100" });
  assertRequest(requests[2], "/api/v1/messages", { account_id: "account-1", cursor: "page-2", limit: "100" });
  assertRequest(requests[3], "/api/v1/messages", { account_id: "account-1", cursor: "page-3", limit: "100" });
});

test("search_messages allows ten pages and rejects larger or invalid bounds", async (t) => {
  const requests = await mockApi(t, (_, page) => ({
    items: Array.from({ length: 100 }, (_, item) => ({ id: `${page}-${item}`, text: "other" })),
    cursor: `page-${page + 1}`,
  }));
  const client = await connectClient(t);
  assert.deepEqual(await callTool(client, "search_messages", { query: "absent", account_id: "account-1", max_pages: 10 }), {
    matches: [], scanned: 1000, cursor: "page-11",
  });
  assert.equal(requests.length, 11);
  assertRequest(requests[0], "/api/v1/accounts/account-1", {});
  for (const max_pages of [0, 11, 1.5]) {
    const result = await client.callTool({ name: "search_messages", arguments: { query: "x", account_id: "account-1", max_pages } });
    assert.equal(result.isError, true);
    await assert.rejects(searchMessages({ query: "x", account_id: "account-1", max_pages }));
  }
  assert.equal(requests.length, 11);
});

test("searchMessages follows a cursor from an empty page", async (t) => {
  const requests = await mockApi(t, (_, page) => ({
    items: page === 1 ? [] : [{ id: "1", text: "Need" }], cursor: page === 1 ? "page-2" : null,
  }));
  assert.deepEqual(await searchMessages({ query: "need", account_id: "account-1" }), {
    matches: [{ id: "1", text: "Need" }], scanned: 1, cursor: null,
  });
  assert.equal(requests.length, 3);
  assertRequest(requests[0], "/api/v1/accounts/account-1", {});
});

test("account tools reject unsupported accounts before any business request", async (t) => {
  const requests = await mockApi(t, undefined, unsupportedAccount);
  const client = await connectClient(t);
  const account_id = unsupportedAccount.id;
  for (const [name, args] of [
    ["list_chats", {}],
    ["get_chat_messages", { chat_id: "chat-1" }],
    ["search_messages", { query: "need" }],
    ["search_messages", { query: "need", chat_id: "chat-1" }],
    ["send_message", { chat_id: "chat-1", text: "hello", confirm: true }],
    ["create_hosted_auth_link", {}],
  ]) {
    assert.deepEqual(await client.callTool({ name, arguments: { ...args, account_id } }), {
      content: [{ type: "text", text: `Error: account ${account_id} is not a LinkedIn account. This plugin supports LinkedIn only.` }],
      isError: true,
    });
  }
  assert.equal(requests.length, 6);
  for (const request of requests) assertRequest(request, `/api/v1/accounts/${account_id}`, {});
});

test("message and chat tools require a nonempty account_id before any HTTP request", async (t) => {
  const requests = await mockApi(t);
  const client = await connectClient(t);
  for (const [name, args] of [
    ["list_chats", {}],
    ["get_chat_messages", { chat_id: "chat-1" }],
    ["search_messages", { query: "need" }],
    ["search_messages", { query: "need", chat_id: "chat-1" }],
    ["send_message", { chat_id: "chat-1", text: "hello", confirm: true }],
  ]) {
    for (const account_id of [undefined, ""]) {
      const result = await client.callTool({ name, arguments: { ...args, account_id } });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /account_id/);
    }
  }
  assert.equal(requests.length, 0);
});

test("send_message without confirm or with confirm=false returns a preview without requests", async (t) => {
  const requests = await mockApi(t, undefined, unsupportedAccount);
  const client = await connectClient(t);
  const preview = { chat_id: "chat-1", account_id: "account-1", text: "你好。\nPlease confirm." };
  for (const confirm of [undefined, false]) {
    assert.deepEqual(await callTool(client, "send_message", { ...preview, confirm }), {
      sent: false,
      preview,
      notice: "该消息将以你本人的身份发出。确认后用 confirm=true 再次调用。",
    });
  }
  assert.equal(requests.length, 0);
});

test("send_message with confirm=true posts encoded chat_id and multipart text and account_id", async (t) => {
  const sent = { object: "MessageSent", message_id: "message-1" };
  const requests = await mockApi(t, () => ({ status: 201, body: JSON.stringify(sent) }));
  const client = await connectClient(t);
  const chat_id = "chat/a ?#% 中文";
  const text = "你好，领英。\nLinkedIn & text=保持原样";
  const account_id = "account & 中文";
  assert.deepEqual(await callTool(client, "send_message", { chat_id, text, account_id, confirm: true }), sent);
  assert.equal(requests.length, 2);
  assertRequest(requests[0], `/api/v1/accounts/${encodeURIComponent(account_id)}`, {});
  const { contentType, body, ...request } = requests[1];
  assert.deepEqual(request, {
    method: "POST", path: `/api/v1/chats/${encodeURIComponent(chat_id)}/messages`, query: {},
    apiKey: "test-key", accept: "application/json",
  });
  assert.match(contentType, /^multipart\/form-data; boundary=.+$/);
  const form = await new Response(body, { headers: { "content-type": contentType } }).formData();
  // FormData serializes text line endings as CRLF.
  assert.deepEqual(Object.fromEntries(form), { text: text.replace(/\r?\n/g, "\r\n"), account_id });
});

test("send_message rejects empty text and nonboolean confirm without requests", async (t) => {
  const requests = await mockApi(t);
  const client = await connectClient(t);
  for (const args of [{ text: "", confirm: true }, { text: "hello", confirm: "true" }]) {
    const result = await client.callTool({
      name: "send_message", arguments: { chat_id: "chat-1", account_id: "account-1", ...args },
    });
    assert.equal(result.isError, true);
  }
  assert.equal(requests.length, 0);
});

test("create_hosted_auth_link fixes providers to LinkedIn and posts normalized api_url and UTC expiration", async (t) => {
  const hosted = { object: "HostedAuthUrl", url: "https://account.unipile.com/test-link" };
  const requests = await mockApi(t, ({ path }) => path === "/api/v1/accounts" ? emptyPage : hosted);
  const api_url = process.env.UNIPILE_DSN;
  process.env.UNIPILE_DSN = `  ${api_url}/api/v1///  `;
  const client = await connectClient(t);
  const name = "  本人的 account name 原样  ";
  for (const expires_in_minutes of [undefined, 1, 42, 1440]) {
    const started = Date.now();
    assert.deepEqual(await callTool(client, "create_hosted_auth_link", { expires_in_minutes, name }), hosted);
    assertRequest(requests.at(-2), "/api/v1/accounts", { limit: "250" });
    const { contentType, body: rawBody, ...request } = requests.at(-1);
    assert.deepEqual(request, {
      method: "POST", path: "/api/v1/hosted/accounts/link", query: {},
      apiKey: "test-key", accept: "application/json",
    });
    assert.equal(contentType, "application/json");
    const { expiresOn, ...body } = JSON.parse(rawBody);
    assert.deepEqual(body, { type: "create", providers: ["LINKEDIN"], api_url, name });
    assert.match(expiresOn, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const duration = (expires_in_minutes ?? 60) * 60000;
    assert.ok(Date.parse(expiresOn) >= started + duration);
    assert.ok(Date.parse(expiresOn) <= Date.now() + duration);
  }
  assert.equal(requests.length, 8);
});

test("create_hosted_auth_link counts nine LinkedIn accounts across two mixed pages before creating", async (t) => {
  const hosted = { object: "HostedAuthUrl", url: "https://account.unipile.com/test-link" };
  const accounts = Array.from({ length: 9 }, (_, index) => ({ id: `account-${index}`, type: "LINKEDIN" }));
  const requests = await mockApi(t, ({ path, query }) => {
    if (path !== "/api/v1/accounts") return hosted;
    return query.cursor
      ? { items: [...accounts.slice(4), unsupportedAccount], cursor: "" }
      : { items: [...accounts.slice(0, 4), unsupportedAccount], cursor: "next+/=&" };
  });
  const client = await connectClient(t);
  assert.deepEqual(await callTool(client, "create_hosted_auth_link"), hosted);
  assert.equal(requests.length, 3);
  assertRequest(requests[0], "/api/v1/accounts", { limit: "250" });
  assertRequest(requests[1], "/api/v1/accounts", { limit: "250", cursor: "next+/=&" });
  assert.equal(requests[2].method, "POST");
  assert.equal(requests[2].path, "/api/v1/hosted/accounts/link");
  assert.deepEqual(JSON.parse(requests[2].body).providers, ["LINKEDIN"]);
});

test("create_hosted_auth_link rejects ten or more LinkedIn accounts without posting a link", async (t) => {
  let count;
  const requests = await mockApi(t, ({ query }) => ({
    items: [
      ...Array.from({ length: query.cursor ? count - 5 : 5 }, (_, index) => ({
        id: `account-${query.cursor ? index + 5 : index}`, type: "LINKEDIN",
      })),
      unsupportedAccount,
    ],
    cursor: query.cursor ? null : "page-2",
  }));
  const client = await connectClient(t);
  for (count of [10, 11]) {
    assert.deepEqual(await client.callTool({ name: "create_hosted_auth_link", arguments: {} }), {
      content: [{ type: "text", text: "Error: 已达 10 个领英账号上限，不能生成新的接入链接。" }],
      isError: true,
    });
    assertRequest(requests.at(-2), "/api/v1/accounts", { limit: "250" });
    assertRequest(requests.at(-1), "/api/v1/accounts", { limit: "250", cursor: "page-2" });
  }
  assert.equal(requests.length, 4);
  assert.equal(requests.some(({ method }) => method === "POST"), false);
});

test("create_hosted_auth_link follows the cursor even when the first account page is empty", async (t) => {
  const hosted = { url: "https://account.unipile.com/test-link" };
  const requests = await mockApi(t, ({ path, query }) => path === "/api/v1/accounts"
    ? { ...emptyPage, cursor: query.cursor ? null : "page-2" }
    : hosted);
  const client = await connectClient(t);
  assert.deepEqual(await callTool(client, "create_hosted_auth_link"), hosted);
  assert.equal(requests.length, 3);
  assertRequest(requests[0], "/api/v1/accounts", { limit: "250" });
  assertRequest(requests[1], "/api/v1/accounts", { limit: "250", cursor: "page-2" });
  assert.equal(requests[2].path, "/api/v1/hosted/accounts/link");
});

test("create_hosted_auth_link reconnects after checking account type without listing accounts", async (t) => {
  const hosted = { object: "HostedAuthUrl", url: "https://account.unipile.com/reconnect-link" };
  const fullPage = { items: Array.from({ length: 10 }, () => ({ type: "LINKEDIN" })), cursor: null };
  const requests = await mockApi(t, ({ path }) => path === "/api/v1/accounts" ? fullPage : hosted);
  const client = await connectClient(t);
  const account_id = "account/a ?#% 中文";
  for (const name of [undefined, "账号名称"]) {
    assert.deepEqual(await callTool(client, "create_hosted_auth_link", { account_id, name }), hosted);
    assertRequest(requests.at(-2), `/api/v1/accounts/${encodeURIComponent(account_id)}`, {});
    assert.equal(requests.at(-1).method, "POST");
    assert.equal(requests.at(-1).path, "/api/v1/hosted/accounts/link");
    const { expiresOn, ...body } = JSON.parse(requests.at(-1).body);
    assert.deepEqual(body, {
      type: "reconnect", reconnect_account: account_id, api_url: process.env.UNIPILE_DSN,
      ...(name === undefined ? {} : { name }),
    });
    assert.match(expiresOn, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  }
  assert.equal(requests.length, 4);
  assert.equal(requests.some(({ path }) => path === "/api/v1/accounts"), false);
});

test("create_hosted_auth_link validates account_id and expiration before requests", async (t) => {
  const requests = await mockApi(t);
  const client = await connectClient(t);
  for (const args of [
    { account_id: "" },
    { expires_in_minutes: 0 },
    { expires_in_minutes: 1441 },
    { expires_in_minutes: 1.5 },
  ]) {
    const result = await client.callTool({ name: "create_hosted_auth_link", arguments: args });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Input validation error/);
  }
  assert.equal(requests.length, 0);
});

test("baseUrl adds https and removes trailing slashes and the API suffix", () => {
  assert.equal(baseUrl("api1.unipile.com:13111"), "https://api1.unipile.com:13111");
  assert.equal(baseUrl(" https://api1.unipile.com:13111/// "), "https://api1.unipile.com:13111");
  assert.equal(baseUrl("http://127.0.0.1:1234/"), "http://127.0.0.1:1234");
  assert.equal(baseUrl("https://api1.unipile.com:13111/api/v1///"), "https://api1.unipile.com:13111");
});

test("resolveProxyUrl skips blank values and selects every proxy variable in priority order", () => {
  assert.equal(resolveProxyUrl({}), null);
  assert.equal(resolveProxyUrl(Object.fromEntries(proxyEnvNames.map((name) => [name, " \t "]))), null);
  const env = Object.fromEntries(proxyEnvNames.map((name, index) => [name, ` http://proxy-${index}.example:8080 \n`]));
  for (let index = 0; index < proxyEnvNames.length; index++) {
    assert.equal(resolveProxyUrl(env), `http://proxy-${index}.example:8080`, proxyEnvNames[index]);
    env[proxyEnvNames[index]] = " \t ";
  }
  assert.equal(resolveProxyUrl(env), null);
});

test("unipileRequest uses direct fetch when no proxy is set", async (t) => {
  const requests = await mockApi(t);
  const directFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (url, options) => {
    assert.equal(Object.hasOwn(options, "dispatcher"), false);
    return directFetch(url, options);
  });
  assert.deepEqual(await unipileRequest("/accounts"), emptyPage);
  assertRequest(requests[0], "/api/v1/accounts", {});
});

test("unipileRequest passes a shared ProxyAgent to concurrent requests and updates proxy settings", async (t) => {
  const requests = await mockApi(t);
  process.env.HTTPS_PROXY = " https://proxy.example:8443 ";
  process.env.HTTP_PROXY = "http://fallback.example:8080";
  const dispatchers = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url.pathname, "/api/v1/accounts");
    assert.ok(options.dispatcher instanceof ProxyAgent);
    assert.equal(options.headers["X-API-KEY"], "test-key");
    assert.ok(options.signal instanceof AbortSignal);
    dispatchers.push(options.dispatcher);
    return Response.json(emptyPage);
  });
  assert.equal(resolveProxyUrl(), "https://proxy.example:8443");
  assert.deepEqual(await Promise.all([unipileRequest("/accounts"), unipileRequest("/accounts")]), [emptyPage, emptyPage]);
  assert.equal(dispatchers[0], dispatchers[1]);
  const oldClose = t.mock.method(dispatchers[0], "close");
  delete process.env.HTTPS_PROXY;
  await unipileRequest("/accounts");
  assert.equal(resolveProxyUrl(), "http://fallback.example:8080");
  assert.notEqual(dispatchers[2], dispatchers[0]);
  assert.ok(oldClose.mock.callCount() > 0);
  await oldClose.mock.calls[0].result;
  assert.equal(dispatchers[0].closed, true);
  delete process.env.HTTP_PROXY;
  assert.equal(getProxyDispatcher(), null);
  assert.equal(requests.length, 0);
});

test("unipileRequest uses lowercase HTTPS and tunnel proxies without a network connection", async (t) => {
  const requests = await mockApi(t);
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    assert.ok(options.dispatcher instanceof ProxyAgent);
    return Response.json(emptyPage);
  });
  for (const name of ["https_proxy", "SAND_EGRESS_TUNNEL_PROXY_ADDR"]) {
    process.env[name] = " http://proxy.example:8080 ";
    assert.equal(resolveProxyUrl(), "http://proxy.example:8080");
    assert.deepEqual(await unipileRequest("/accounts"), emptyPage);
    delete process.env[name];
  }
  assert.equal(requests.length, 0);
});

test("invalid proxy settings and proxy fetch failures allow later requests", async (t) => {
  const requests = await mockApi(t);
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Proxy failure for test-key");
  });
  process.env.HTTPS_PROXY = "not a proxy URL";
  await assert.rejects(unipileRequest("/accounts"), { message: "Invalid URL" });
  assert.equal(fetchMock.mock.callCount(), 0);
  process.env.HTTPS_PROXY = "http://proxy.example:8080";
  await assert.rejects(unipileRequest("/accounts"), { message: "Proxy failure for [REDACTED]" });
  fetchMock.mock.mockImplementation(async () => Response.json(emptyPage));
  assert.deepEqual(await unipileRequest("/accounts"), emptyPage);
  assert.equal(requests.length, 0);
});

test("unipileRequest reads environment variables on each call", async (t) => {
  const requests = await mockApi(t);
  await unipileRequest("/accounts", { query: { cursor: undefined, limit: undefined } });
  process.env.UNIPILE_API_KEY = "replacement-key";
  process.env.UNIPILE_DSN += "///";
  await unipileRequest("/accounts", { query: { cursor: "new-page", limit: 100 } });
  assertRequest(requests[0], "/api/v1/accounts", {});
  assert.deepEqual(requests[1], {
    method: "GET", path: "/api/v1/accounts", query: { cursor: "new-page", limit: "100" },
    apiKey: "replacement-key", accept: "application/json",
  });
});

test("missing environment variables produce a clear error without the API key", async (t) => {
  const requests = await mockApi(t);
  for (const [key, dsn] of [["test-key", undefined], [undefined, "http://localhost"], [undefined, undefined], [" ", " "]]) {
    if (key === undefined) delete process.env.UNIPILE_API_KEY;
    else process.env.UNIPILE_API_KEY = key;
    if (dsn === undefined) delete process.env.UNIPILE_DSN;
    else process.env.UNIPILE_DSN = dsn;
    await assert.rejects(unipileRequest("/accounts"), (error) => {
      assert.match(error.message, /^Missing UNIPILE_API_KEY \/ UNIPILE_DSN\./);
      assert.equal(error.message.includes("test-key"), false);
      return true;
    });
    const client = await connectClient(t);
    const result = await client.callTool({ name: "create_hosted_auth_link", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^Error: Missing UNIPILE_API_KEY \/ UNIPILE_DSN\./);
    assert.equal(result.content[0].text.includes("test-key"), false);
  }
  assert.equal(requests.length, 0);
});

test("HTTP errors include status and a redacted response limited to 500 characters", async (t) => {
  await mockApi(t, () => ({ status: 429, body: `Denied test-key ${"x".repeat(600)} END` }));
  await assert.rejects(unipileRequest("/accounts"), (error) => {
    const prefix = "Unipile HTTP 429: ";
    assert.ok(error.message.startsWith(prefix));
    const body = error.message.slice(prefix.length);
    assert.equal(body.length, 500);
    assert.ok(body.startsWith("Denied [REDACTED] "));
    assert.equal(body.includes("test-key"), false);
    assert.equal(body.includes("END"), false);
    return true;
  });
});

test("all handlers return isError and continue to handle later requests", async (t) => {
  let fail = true;
  await mockApi(t, () => fail ? { status: 500, body: "Failed test-key" } : emptyPage);
  const client = await connectClient(t);
  for (const [name, args] of [
    ["list_accounts", {}],
    ["list_chats", { account_id: "account-1" }],
    ["get_chat_messages", { chat_id: "chat-1", account_id: "account-1" }],
    ["search_messages", { query: "need", account_id: "account-1" }],
    ["send_message", { chat_id: "chat-1", text: "hello", account_id: "account-1", confirm: true }],
    ["create_hosted_auth_link", {}],
  ]) {
    const result = await client.callTool({ name, arguments: args });
    assert.deepEqual(result, {
      content: [{ type: "text", text: "Error: Unipile HTTP 500: Failed [REDACTED]" }],
      isError: true,
    });
  }
  fail = false;
  assert.deepEqual(await callTool(client, "list_accounts"), { items: [], cursor: null });
});

test("tools validate limit and UTC times before any HTTP request", async (t) => {
  const requests = await mockApi(t);
  const client = await connectClient(t);
  for (const [name, args] of [
    ["list_accounts", { limit: 0 }],
    ["list_accounts", { limit: 251 }],
    ["list_accounts", { limit: 1.5 }],
    ["list_chats", { account_id: "account-1", before: "2026-10-10" }],
    ["get_chat_messages", { chat_id: "chat-1", account_id: "account-1", after: "2026-10-01T00:00:00+08:00" }],
  ]) {
    assert.equal((await client.callTool({ name, arguments: args })).isError, true);
  }
  assert.equal(requests.length, 0);
});

test("unipileRequest sets a 30 second timeout and redacts fetch errors", async (t) => {
  const requests = await mockApi(t);
  const signal = new AbortController().signal;
  t.mock.method(AbortSignal, "timeout", (milliseconds) => {
    assert.equal(milliseconds, 30000);
    return signal;
  });
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url.pathname, "/api/v1/accounts");
    assert.equal(options.signal, signal);
    throw new Error("Network failure for test-key");
  });
  await assert.rejects(unipileRequest("/accounts"), { message: "Network failure for [REDACTED]" });
  assert.equal(requests.length, 0);
});
