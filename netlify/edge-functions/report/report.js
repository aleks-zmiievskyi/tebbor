// GET /api/report?id=…: віддає розбір стрімом.
//  • done        → весь текст одразу;
//  • generating  → «стежимо»: читаємо з Blobs, що вже написано, і досилаємо нове;
//  • new / error / завислий generating → генеруємо через OpenRouter.
// Генерація йде у context.waitUntil і пише текст у Blobs кожні кілька секунд,
// тому розбір дописується, навіть якщо людина закрила вкладку чи пішла на оплату.
import { SYSTEM_PROMPT } from "../../shared/prompt.js";
import {
  buildUserMessage, reports, ID_RE, jsonError, sseParser, HEARTBEAT, DONE_MARK,
} from "../../shared/lib.js";

const DEFAULT_MODEL = "anthropic/claude-sonnet-4.5";
const STALE_MS = 60000;   // generating без оновлень довше — генератор помер, можна перезапускати
const SAVE_MS = 4000;     // як часто генератор зберігає текст
const POLL_MS = 2000;     // як часто «стежач» перечитує Blobs
const BEAT_MS = 3000;
const MAX_ATTEMPTS = 5;   // захист від нескінченних перегенерацій одного розбору

const enc = new TextEncoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async (req, context) => {
  if (req.method !== "GET") return jsonError("Method not allowed", 405);
  const id = new URL(req.url).searchParams.get("id") || "";
  if (!ID_RE.test(id)) return jsonError("Розбір не знайдено", 404);

  const store = reports();
  const got = await store.getWithMetadata(id, { type: "json" });
  if (!got?.data) return jsonError("Розбір не знайдено", 404);
  const rec = got.data;

  const headers = {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    // сторінці потрібні відповіді (напр. «Не знаю» в «Куди тягне»), коли її відкрили за посиланням
    "X-Answers": JSON.stringify(rec.answers),
  };

  if (rec.status === "done") return new Response(rec.text + DONE_MARK, { headers });

  if (rec.status === "generating" && Date.now() - rec.updatedAt < STALE_MS) {
    return new Response(follow(store, id), { headers });
  }

  if ((rec.attempts || 0) >= MAX_ATTEMPTS) {
    return jsonError("Забагато спроб для цього розбору. Напиши нам — розберемось.", 429);
  }

  const key = Netlify.env.get("OPENROUTER_API_KEY");
  if (!key) return jsonError("Сервер не налаштовано (нема ключа)", 500);
  const model = Netlify.env.get("OPENROUTER_MODEL") || DEFAULT_MODEL;

  // Займаємо генерацію атомарно: якщо дві вкладки прийшли одночасно, генерує лише одна,
  // друга стежить.
  const claim = {
    ...rec, status: "generating", text: "", updatedAt: Date.now(), attempts: (rec.attempts || 0) + 1,
  };
  const claimed = await store.setJSON(id, claim, { onlyIfMatch: got.etag });
  if (!claimed?.modified) return new Response(follow(store, id), { headers });

  const save = (status, text) => store.setJSON(id, { ...claim, status, text, updatedAt: Date.now() });

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
        { role: "user", content: buildUserMessage(rec.answers) },
      ],
    }),
  }).catch(() => null);

  if (!upstream?.ok || !upstream.body) {
    console.log("OpenRouter error", upstream?.status, await upstream?.text().catch(() => ""));
    await save("error", "").catch(() => {});
    return jsonError("Модель недоступна, спробуй за хвилину", 502);
  }

  // Потік для браузера. Якщо людина пішла — просто перестаємо слати, генерація триває.
  let out, clientGone = false, lastSent = 0;
  const stream = new ReadableStream({ start(c) { out = c; }, cancel() { clientGone = true; } });
  const emit = (s) => {
    if (clientGone) return;
    try { out.enqueue(enc.encode(s)); lastSent = Date.now(); } catch { clientGone = true; }
  };

  const job = (async () => {
    let text = "", finish = null, failed = false, saving = null;
    emit(HEARTBEAT); // одразу віддати перший байт
    const beat = setInterval(() => { if (Date.now() - lastSent >= BEAT_MS) emit(HEARTBEAT); }, 1000);
    const saver = setInterval(() => {
      if (!saving) saving = save("generating", text).catch(() => {}).finally(() => { saving = null; });
    }, SAVE_MS);
    const parser = sseParser({
      onText: (t) => { text += t; emit(t); },
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
      console.log("upstream read failed", e);
    }
    clearInterval(beat);
    clearInterval(saver);
    if (saving) await saving;
    const ok = !failed && text.trim() && finish && finish !== "length" && finish !== "error";
    await save(ok ? "done" : "error", text).catch((e) => console.log("final save failed", e));
    if (ok) emit(DONE_MARK);
    if (!clientGone) try { out.close(); } catch { /* вже закрито */ }
  })();

  context.waitUntil(job);
  return new Response(stream, { headers });
};

// Стежимо за розбором, який генерує інший запит: віддаємо вже написане і досилаємо нове.
function follow(store, id) {
  let closed = false;
  return new ReadableStream({
    start(c) {
      let lastSent = 0, sent = 0;
      const emit = (s) => {
        if (closed) return;
        try { c.enqueue(enc.encode(s)); lastSent = Date.now(); } catch { closed = true; }
      };
      (async () => {
        emit(HEARTBEAT);
        while (!closed) {
          const rec = await store.get(id, { type: "json" }).catch(() => null);
          if (!rec || rec.text.length < sent) break; // зник або перезапустився — хай сторінка перепитає
          if (rec.text.length > sent) { emit(rec.text.slice(sent)); sent = rec.text.length; }
          if (rec.status === "done") { emit(DONE_MARK); break; }
          if (rec.status !== "generating" || Date.now() - rec.updatedAt > STALE_MS) break;
          if (Date.now() - lastSent >= BEAT_MS) emit(HEARTBEAT);
          await sleep(POLL_MS);
        }
        if (!closed) try { c.close(); } catch { /* вже закрито */ }
      })();
    },
    cancel() { closed = true; },
  });
}

export const config = { path: "/api/report" };
