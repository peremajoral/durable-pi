import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { tempStore } from "./helpers.js";
import { Store } from "../src/store.js";

test("ollama provider: lists chat models, routes, validates and answers over openai-completions", async () => {
  const chats: { model: string }[] = [];
  const server = createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ data: [{ id: "glm:cloud" }, { id: "bge-m3:latest" }, { id: "kimi:cloud" }] }));
    }
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      chats.push(JSON.parse(body));
      res.setHeader("content-type", "text/event-stream");
      const chunk = (delta: object, finish: string | null) =>
        `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.end(chunk({ role: "assistant", content: "hola" }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  process.env.DPI_OLLAMA_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  process.env.DPI_OLLAMA_MODEL = "kimi:cloud";
  const t = await tempStore();
  const store = await Store.open({ ...t.options, provider: "ollama" });
  try {
    const info = store.deviceInfo();
    assert.deepEqual(info.models.map((m) => `${m.provider}/${m.id}`), ["ollama/glm:cloud", "ollama/kimi:cloud"]);
    assert.equal(info.defaultModel, "kimi:cloud");
    assert.deepEqual(store.routedModel({ provider: "openrouter", modelId: "x" } as never), { provider: "ollama", modelId: "kimi:cloud" });
    assert.throws(() => store.validateModel({ provider: "ollama", modelId: "bge-m3:latest" }), /Unknown model/);

    const session = await store.create({ name: "O", cwd: "project", model: { provider: "ollama", modelId: "glm:cloud" } });
    const { h, c } = await store.resolveAgent(session.id, "main");
    const sent = await store.send(c, { content: "hi", requestId: "o-1" });
    const answer = await store.settled(h, sent.id as number, 15000);
    assert.equal(answer.status, "done");
    assert.equal(answer.answer?.text, "hola");
    assert.equal(chats.at(-1)?.model, "glm:cloud");
  } finally {
    await store.close();
    server.close();
    await t.cleanup();
  }
});
