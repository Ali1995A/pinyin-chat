/* eslint-disable no-console */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");

const ROOT = __dirname;
const INDEX_PATH = path.join(ROOT, "index.html");
const ENV_PATH = path.join(ROOT, ".env");

function readTextFileOrNull(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function parseDotEnv(text) {
  const env = {};
  if (!text) return env;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function loadConfig() {
  const env = {
    ...process.env,
    ...parseDotEnv(readTextFileOrNull(ENV_PATH)),
  };

  const apiKey = env.DEEPSEEK_API_KEY || "";
  const url = env.DEEPSEEK_URL || "https://api.deepseek.com/v1";
  const model = env.DEEPSEEK_MODEL || "deepseek-chat";

  return { apiKey, url, model };
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(text);
}

function text(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function getDeepSeekChatCompletionsEndpoint(deepseekUrl) {
  const u = new URL(deepseekUrl);
  // 如果用户已经填了完整 endpoint，直接用
  if (u.pathname.endsWith("/chat/completions")) return u.toString();
  // 兼容填 /v1 或根域名
  let basePath = u.pathname.replace(/\/+$/, "");
  if (!basePath.endsWith("/v1")) basePath = `${basePath}/v1`.replace(/\/{2,}/g, "/");
  u.pathname = `${basePath}/chat/completions`.replace(/\/{2,}/g, "/");
  return u.toString();
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const buf = Buffer.concat(chunks);
  const textBody = buf.toString("utf8");
  if (!textBody) return {};
  return JSON.parse(textBody);
}

async function handleApiChat(req, res) {
  const { apiKey, url, model: defaultModel } = loadConfig();
  if (!apiKey) {
    return json(res, 400, {
      error:
        "Missing DEEPSEEK_API_KEY. Create .env next to server.js (see .env.example).",
    });
  }

  let payload;
  try {
    payload = await readJson(req);
  } catch (e) {
    return json(res, 400, { error: `Invalid JSON: ${String(e?.message || e)}` });
  }

  const messages = payload?.messages;
  const temperature = payload?.temperature;
  const max_tokens = payload?.max_tokens;
  const model = payload?.model || defaultModel;
  const stream = Boolean(payload?.stream);

  if (!Array.isArray(messages) || messages.length === 0) {
    return json(res, 400, { error: "messages must be a non-empty array" });
  }
  if (!model) {
    return json(res, 400, { error: "model is empty; set DEEPSEEK_MODEL or pass model" });
  }

  const endpoint = getDeepSeekChatCompletionsEndpoint(url);

  const body = {
    model,
    messages,
    temperature: typeof temperature === "number" ? temperature : 0.6,
  };
  if (typeof max_tokens === "number") body.max_tokens = max_tokens;
  if (stream) body.stream = true;

  const controller = new AbortController();
  const abortUpstream = () => {
    if (!controller.signal.aborted) controller.abort();
  };
  // Only abort when the client actually aborts/disconnects early.
  req.on("aborted", abortUpstream);
  res.on("close", () => {
    if (!res.writableEnded) abortUpstream();
  });

  let upstreamRes;
  let upstreamJson;
  try {
    upstreamRes = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!stream) upstreamJson = await upstreamRes.json().catch(() => ({}));
  } catch (e) {
    return json(res, 502, { error: `Upstream fetch failed: ${String(e?.message || e)}` });
  }

  if (!upstreamRes.ok) {
    if (stream) upstreamJson = await upstreamRes.json().catch(() => ({}));
    const msg =
      upstreamJson?.error?.message ||
      upstreamJson?.message ||
      `Upstream HTTP ${upstreamRes.status}`;
    return json(res, 502, { error: msg, raw: upstreamJson });
  }

  if (stream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    if (!upstreamRes.body) {
      res.end("data: [DONE]\n\n");
      return;
    }

    const ct = upstreamRes.headers.get("content-type") || "";
    if (!ct.includes("text/event-stream")) {
      const one = await upstreamRes.json().catch(() => ({}));
      const content = one?.choices?.[0]?.message?.content || "";
      if (content) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
      }
      res.end("data: [DONE]\n\n");
      return;
    }

    try {
      for await (const chunk of upstreamRes.body) res.write(chunk);
    } catch (e) {
      res.write(`data: ${JSON.stringify({ error: String(e?.message || e) })}\n\n`);
    } finally {
      res.end();
    }
    return;
  }

  const content = upstreamJson?.choices?.[0]?.message?.content;
  if (!content) {
    return json(res, 502, { error: "Upstream returned no choices[0].message.content", raw: upstreamJson });
  }

  return json(res, 200, { content: String(content).trim() });
}

function handleConfig(req, res) {
  const { url, model } = loadConfig();
  json(res, 200, {
    provider: "deepseek",
    url,
    model,
    mode: "proxy",
  });
}

function serveIndex(res) {
  const html = readTextFileOrNull(INDEX_PATH);
  if (!html) return text(res, 404, "index.html not found");
  return text(res, 200, html, "text/html; charset=utf-8");
}

const server = http.createServer(async (req, res) => {
  const method = req.method || "GET";
  const url = new URL(req.url || "/", "http://localhost");

  if (method === "GET" && url.pathname === "/") return serveIndex(res);
  if (method === "GET" && url.pathname === "/index.html") return serveIndex(res);
  if (method === "GET" && url.pathname === "/api/config") return handleConfig(req, res);
  if (method === "GET" && url.pathname === "/config") return handleConfig(req, res);
  if (method === "POST" && url.pathname === "/api/chat") return handleApiChat(req, res);

  return text(res, 404, "Not Found");
});

const port = Number(process.env.PORT || "5179");
server.listen(port, "127.0.0.1", () => {
  console.log(`Pinyin Father Chat running: http://127.0.0.1:${port}`);
  console.log(`Config: create ${ENV_PATH} (see .env.example)`);
});
