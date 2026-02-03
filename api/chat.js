function getDeepSeekChatCompletionsEndpoint(deepseekUrl) {
  const u = new URL(deepseekUrl);
  if (u.pathname.endsWith("/chat/completions")) return u.toString();
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

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "Method Not Allowed" }));
    return;
  }

  const apiKey = process.env.DEEPSEEK_API_KEY || "";
  const url = process.env.DEEPSEEK_URL || "https://api.deepseek.com/v1";
  const defaultModel = process.env.DEEPSEEK_MODEL || "deepseek-chat";

  if (!apiKey) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify({
        error: "Missing DEEPSEEK_API_KEY. Set it in Vercel Project Settings → Environment Variables.",
      }),
    );
    return;
  }

  let payload;
  try {
    payload = await readJson(req);
  } catch (e) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: `Invalid JSON: ${String(e?.message || e)}` }));
    return;
  }

  const messages = payload?.messages;
  const temperature = payload?.temperature;
  const max_tokens = payload?.max_tokens;
  const model = payload?.model || defaultModel;
  const stream = Boolean(payload?.stream);

  if (!Array.isArray(messages) || messages.length === 0) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "messages must be a non-empty array" }));
    return;
  }
  if (!model) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "model is empty; set DEEPSEEK_MODEL or pass model" }));
    return;
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
  req.on("close", () => controller.abort());

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
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: `Upstream fetch failed: ${String(e?.message || e)}` }));
    return;
  }

  if (!upstreamRes.ok) {
    if (stream) upstreamJson = await upstreamRes.json().catch(() => ({}));
    const msg =
      upstreamJson?.error?.message ||
      upstreamJson?.message ||
      `Upstream HTTP ${upstreamRes.status}`;
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: msg, raw: upstreamJson }));
    return;
  }

  if (stream) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

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
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify({ error: "Upstream returned no choices[0].message.content", raw: upstreamJson }),
    );
    return;
  }

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.statusCode = 200;
  res.end(JSON.stringify({ content: String(content).trim() }));
};
