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

export const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
export const jsonError = (msg, status, extra = {}) => json({ error: msg, ...extra }, status);

// ---- creem (К8) ----
// Пейвол увімкнено, коли є ключ і продукт, і PAYWALL не "off".
// PAYWALL=off — для тесту на знайомих (П12): розбір без оплати.
// Ключ creem_test_… → тестовий API (без реальних грошей).
export function creemConfig() {
  const key = Netlify.env.get("CREEM_API_KEY") || "";
  const product = Netlify.env.get("CREEM_PRODUCT_ID") || "";
  const off = (Netlify.env.get("PAYWALL") || "").toLowerCase() === "off";
  const base = Netlify.env.get("CREEM_API_BASE") ||
    (key.startsWith("creem_test_") ? "https://test-api.creem.io" : "https://api.creem.io");
  return { key, product, base, enabled: Boolean(key && product && !off) };
}

export async function creemCreateCheckout(cfg, id, successUrl) {
  const r = await fetch(`${cfg.base}/v1/checkouts`, {
    method: "POST",
    headers: { "x-api-key": cfg.key, "Content-Type": "application/json" },
    body: JSON.stringify({
      product_id: cfg.product,
      request_id: id,
      success_url: successUrl,
      metadata: { report_id: id },
    }),
  });
  if (!r.ok) throw new Error(`creem create ${r.status}: ${await r.text().catch(() => "")}`);
  return r.json(); // { id, checkout_url, status, ... }
}

// Оплачено = checkout completed, замовлення paid, і це саме наш розбір і наш продукт.
export async function creemIsPaid(cfg, checkoutId, id) {
  const r = await fetch(`${cfg.base}/v1/checkouts?checkout_id=${encodeURIComponent(checkoutId)}`, {
    headers: { "x-api-key": cfg.key },
  });
  if (!r.ok) throw new Error(`creem get ${r.status}: ${await r.text().catch(() => "")}`);
  const c = await r.json();
  const productId = typeof c.product === "string" ? c.product : c.product?.id;
  const paid = c.status === "completed" && (!c.order || c.order.status === "paid");
  return { paid: paid && c.request_id === id && productId === cfg.product, status: c.status, checkout: c };
}

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
