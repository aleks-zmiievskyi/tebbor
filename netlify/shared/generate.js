// Одна генерація розбору: OpenRouter (стрім) → текст у Blobs кожні кілька секунд → done/error.
// Використовується і фоновою функцією (основний шлях), і edge-функцією (запасний шлях).
// claim — запис, яким цей виконавець «зайняв» розбір; claim.claimToken захищає від того,
// щоб старий виконавець перезаписав результат нового.
import { SYSTEM_PROMPT } from "./prompt.js";
import { buildUserMessage, sseParser } from "./lib.js";

const DEFAULT_MODEL = "anthropic/claude-sonnet-4.5";
const SAVE_MS = 2500;

export async function generate({ store, id, claim, onText = () => {} }) {
  const key = Netlify.env.get("OPENROUTER_API_KEY");
  const model = Netlify.env.get("OPENROUTER_MODEL") || DEFAULT_MODEL;

  const stillMine = async () => {
    const cur = await store.get(id, { type: "json" }).catch(() => null);
    return cur?.claimToken === claim.claimToken;
  };
  const save = async (status, text) => {
    if (!(await stillMine())) return false;
    await store.setJSON(id, { ...claim, status, text, updatedAt: Date.now() });
    return true;
  };

  if (!key) { await save("error", "").catch(() => {}); return { ok: false, reason: "no_key" }; }

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
        { role: "user", content: buildUserMessage(claim.answers) },
      ],
    }),
  }).catch(() => null);

  if (!upstream?.ok || !upstream.body) {
    console.log("OpenRouter error", upstream?.status, await upstream?.text().catch(() => ""));
    await save("error", "").catch(() => {});
    return { ok: false, reason: "upstream" };
  }

  let text = "", finish = null, failed = false, saving = null;
  const saver = setInterval(() => {
    if (!saving) saving = save("generating", text).catch(() => {}).finally(() => { saving = null; });
  }, SAVE_MS);
  const parser = sseParser({
    onText: (t) => { text += t; onText(t); },
    onFinish: (f) => { finish = f; },
    onError: (e) => { failed = true; console.log("OpenRouter stream error", JSON.stringify(e)); },
  });
  try {
    const reader = upstream.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      parser.push(value);
    }
    parser.end();
  } catch (e) {
    failed = true;
    console.log("upstream read failed", String(e));
  }
  clearInterval(saver);
  if (saving) await saving;
  const ok = Boolean(!failed && text.trim() && finish && finish !== "length" && finish !== "error");
  await save(ok ? "done" : "error", text).catch((e) => console.log("final save failed", String(e)));
  return { ok };
}
