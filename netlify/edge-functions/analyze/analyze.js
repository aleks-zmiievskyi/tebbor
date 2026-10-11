// Netlify Edge Function: анкета (індекси) → промпт → OpenRouter (стрім) → текст.
// Edge, бо звичайні функції на безкоштовному плані обриваються через 10 с.
// Тека analyze/ = одна функція; prompt.js і lib.js тут — допоміжні модулі, не функції.
import { SYSTEM_PROMPT } from "./prompt.js";
import { buildUserMessage, sseToText } from "./lib.js";

const DEFAULT_MODEL = "anthropic/claude-sonnet-4.5";

const jsonError = (msg, status) =>
  new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

export default async (req) => {
  if (req.method !== "POST") return jsonError("Method not allowed", 405);

  let body;
  try { body = await req.json(); } catch { return jsonError("Bad JSON", 400); }

  const userMessage = buildUserMessage(body?.answers);
  if (!userMessage) return jsonError("Некоректні відповіді", 400);

  const key = Netlify.env.get("OPENROUTER_API_KEY");
  if (!key) return jsonError("Сервер не налаштовано (нема ключа)", 500);
  const model = Netlify.env.get("OPENROUTER_MODEL") || DEFAULT_MODEL;

  const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://tebbor.netlify.app",
      "X-Title": "tebbor",
    },
    body: JSON.stringify({
      model,
      stream: true,
      temperature: 0.4,
      max_tokens: 8000,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
    }),
  });

  if (!upstream.ok || !upstream.body) {
    console.log("OpenRouter error", upstream.status, await upstream.text().catch(() => ""));
    return jsonError("Модель недоступна, спробуй за хвилину", 502);
  }

  return new Response(upstream.body.pipeThrough(sseToText()), {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
};

export const config = { path: "/api/analyze" };
