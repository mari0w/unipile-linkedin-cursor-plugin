import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("stdio initialize and tools/list expose exactly six tools", { timeout: 10000 }, async (t) => {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../index.js", import.meta.url))], {
    env: { ...process.env, UNIPILE_API_KEY: "", UNIPILE_DSN: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  const lines = createInterface({ input: child.stdout });
  const responses = lines[Symbol.asyncIterator]();
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (data) => { stderr += data; });
  t.after(async () => {
    lines.close();
    child.kill();
    await exited;
  });
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const receive = async () => {
    const { value, done } = await responses.next();
    assert.equal(done, false, stderr);
    return JSON.parse(value);
  };

  send({
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "unipile-linkedin-stdio-test", version: "1.0.0" },
    },
  });
  const initialized = await receive();
  assert.equal(initialized.id, 1);
  assert.equal(initialized.result.serverInfo.name, "unipile-linkedin");
  send({ method: "notifications/initialized" });
  send({ id: 2, method: "tools/list", params: {} });
  const listed = await receive();
  assert.equal(listed.id, 2);
  assert.deepEqual(listed.result.tools.map((tool) => tool.name).sort(), [
    "create_hosted_auth_link", "get_chat_messages", "list_accounts", "list_chats", "search_messages", "send_message",
  ]);
  assert.equal(listed.result.tools.length, 6);
  for (const tool of listed.result.tools) {
    assert.match(tool.description, /只支持领英账号/);
    assert.match(tool.description, /不支持其他平台/);
  }
  for (const name of ["list_chats", "get_chat_messages", "search_messages", "send_message"]) {
    const tool = listed.result.tools.find((tool) => tool.name === name);
    assert.ok(tool.inputSchema.required.includes("account_id"));
    assert.match(tool.description, /list_accounts/);
  }
  const hosted = listed.result.tools.find((tool) => tool.name === "create_hosted_auth_link");
  assert.equal(hosted.inputSchema.properties.providers, undefined);
  assert.match(hosted.description, /最多接入 10 个领英账号/);
  const chats = listed.result.tools.find((tool) => tool.name === "list_chats");
  assert.equal(chats.inputSchema.properties.account_type, undefined);
  assert.equal(hosted.inputSchema.properties.expires_in_minutes.default, 60);

  send({ id: 3, method: "tools/call", params: { name: "list_accounts", arguments: {} } });
  const failed = await receive();
  assert.equal(failed.id, 3);
  assert.equal(failed.result.isError, true);
  assert.match(failed.result.content[0].text, /^Error: Missing UNIPILE_API_KEY \/ UNIPILE_DSN\./);
  send({ id: 4, method: "tools/list", params: {} });
  assert.equal((await receive()).result.tools.length, 6);
  assert.equal(stderr, "");
});
