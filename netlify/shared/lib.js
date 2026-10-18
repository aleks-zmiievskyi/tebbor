import { getStore } from "@netlify/blobs";
import { QUESTIONS } from "../../public/questions.js";

export function buildUserMessage(answers) {
  if (!Array.isArray(answers) || answers.length !== QUESTIONS.length) return null;
  const lines = [];
  for (let i = 0; i < QUESTIONS.length; i++) {
    const q = QUESTIONS[i];
    const idx = Array.isArray(answers[i]) ? answers[i] : [answers[i]];
    const bad =
      idx.length === 0 ||
      (!q.multi && idx.length !== 1) ||
      new Set(idx).size !== idx.length ||
      idx.some((n) => !Number.isInteger(n) || n < 0 || n >= q.opts.length);
    if (bad) return null;
    lines.push(`${q.label}: ${idx.map((n) => q.opts[n]).join(", ")}`);
  }
  return lines.join("\n");
}

// Розбори живуть у Netlify Blobs: ключ = id (uuid), значення =
// { answers, status: "new" | "generating" | "done" | "error", text, created, updatedAt, attempts }
export const reports = () => getStore({ name: "reports", consistency: "strong" });
export const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const jsonError = (msg, status) =>
  new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

// Пульс: поки модель «думає» і не віддає тексту, з'єднання мовчить, і проміжні
// проксі можуть його обірвати. Тому раз на 3 с шлемо невидимий символ, який сторінка викидає.
export const HEARTBEAT = "​";
// Маркер «відповідь дописана до кінця». Нема маркера — сторінка знає, що розбір обірвався.
export const DONE_MARK = "⁠";

// SSE від OpenRouter → виклики onText / onFinish / onError
export function sseParser({ onText, onFinish, onError }) {
  const dec = new TextDecoder();
  let buf = "";
  const handle = (line) => {
    line = line.trim();
    if (!line.startsWith("data:")) return; // коментарі ": OPENROUTER PROCESSING" тощо
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    try {
      const j = JSON.parse(data);
      if (j.error) { onError(j.error); return; }
      const c = j.choices?.[0];
      const t = c?.delta?.content;
      if (t) onText(t);
      if (c?.finish_reason) onFinish(c.finish_reason);
    } catch { /* неповний/службовий рядок — пропускаємо */ }
  };
  return {
    push(chunk) {
      buf += dec.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        handle(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    },
    end() { if (buf) handle(buf); buf = ""; },
  };
}
