/* eslint-disable no-console */
const http = require("node:http");
const { spawn } = require("node:child_process");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { res, text, json };
}

async function readSseText(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`SSE HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  if (!res.body) throw new Error("No response body for SSE");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let full = "";

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    while (true) {
      const idx = buf.indexOf("\n\n");
      if (idx < 0) break;
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of raw.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let obj;
        try {
          obj = JSON.parse(data);
        } catch {
          continue;
        }
        if (obj?.error) throw new Error(String(obj.error));
        const delta = obj?.choices?.[0]?.delta?.content || "";
        if (typeof delta === "string" && delta) full += delta;
      }
    }
  }

  return full.trim();
}

async function waitForServer(url, timeoutMs = 5000) {
  const started = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (res.ok) return;
    } catch {}
    if (Date.now() - started > timeoutMs) throw new Error("Server not ready in time");
    await sleep(120);
  }
}

async function main() {
  // Start local dev server (reads .env) on a dedicated port to avoid conflicts.
  const port = 5181;

  console.log("[smoke] starting local server...");
  const child = spawn(process.execPath, ["server.js"], {
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
    cwd: process.cwd(),
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
  child.stderr.on("data", (d) => (stderr += d.toString("utf8")));

  try {
    await waitForServer(`http://127.0.0.1:${port}/api/config`, 7000);

    const cfg = await fetchJson(`http://127.0.0.1:${port}/api/config`);
    if (!cfg.res.ok || !cfg.json) throw new Error(`config failed: ${cfg.text.slice(0, 200)}`);
    console.log("[smoke] config ok:", { provider: cfg.json.provider, model: cfg.json.model });

    const prompt = "请用简体中文，爸爸视角，回复孩子：我有点害怕黑。输出两句短句。";
    const body = {
      messages: [
        { role: "system", content: "你是一位温柔、坚定、会倾听的父亲。只用简体中文回复。不要表情符号。" },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 120,
    };

    const nonStream = await fetchJson(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!nonStream.res.ok) throw new Error(`chat(non-stream) failed: ${nonStream.text.slice(0, 200)}`);
    const content = nonStream.json?.content;
    if (!content || typeof content !== "string") throw new Error("chat(non-stream) missing content");
    console.log("[smoke] chat(non-stream) ok:", content.slice(0, 60).replace(/\s+/g, " "));

    const sseText = await readSseText(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, stream: true }),
    });
    if (!sseText) throw new Error("chat(stream) empty");
    console.log("[smoke] chat(stream) ok:", sseText.slice(0, 60).replace(/\s+/g, " "));

    console.log("[smoke] ✅ all good");
  } finally {
    if (child.pid) {
      try {
        child.kill("SIGTERM");
      } catch {}
      // ensure it exits
      await Promise.race([
        new Promise((r) => child.on("exit", r)),
        sleep(800),
      ]);
      try {
        child.kill("SIGKILL");
      } catch {}
    }
    // silence unused vars but keep for debugging if needed
    void stdout;
    void stderr;
  }
}

main().catch((e) => {
  console.error("[smoke] ❌ failed:", String(e?.message || e));
  process.exitCode = 1;
});

