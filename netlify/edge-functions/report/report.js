// GET /api/report?id=…: віддає розбір стрімом.
//  • done        → весь текст одразу;
//  • generating  → «стежимо»: читаємо з Blobs, що вже написано, і досилаємо нове;
//  • new / error / завислий generating → запускаємо генерацію і стежимо.
// Генерує фонова функція generate-background (до 15 хв, не залежить від браузера) і пише
// текст у Blobs кожні кілька секунд — розбір дописується, навіть якщо телефон заблокували.
import {
  reports, ID_RE, jsonError, HEARTBEAT, DONE_MARK, creemConfig, creemIsPaid,
} from "../../shared/lib.js";
import { generate } from "../../shared/generate.js";

const STALE_MS = 45000;   // generating без оновлень довше — генератор помер, можна перезапускати
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
  let got = await store.getWithMetadata(id, { type: "json" });
  if (!got?.data) return jsonError("Розбір не знайдено", 404);

  // К8: не оплачено → перевіряємо в creem; оплачено → переводимо в "new" і генеруємо.
  if (got.data.status === "unpaid") {
    const cfg = creemConfig();
    let paidBy = null, pending = false;
    if (cfg.enabled) {
      for (const co of got.data.checkouts || []) {
        try {
          const r = await creemIsPaid(cfg, co, id);
          if (r.paid) { paidBy = co; break; }
          if (r.status === "pending" || r.status === "processing") pending = true;
        } catch (e) { console.log(String(e)); pending = true; }
      }
    }
    if (cfg.enabled && !paidBy) {
      return jsonError("payment_required", 402, { pending, hasCheckout: (got.data.checkouts || []).length > 0 });
    }
    // оплачено (або пейвол вимкнули) — знімаємо замок, далі звичайна логіка
    await store.setJSON(id, { ...got.data, status: "new", paidBy, paidAt: paidBy ? Date.now() : null },
      { onlyIfMatch: got.etag });
    got = await store.getWithMetadata(id, { type: "json" });
    if (!got?.data) return jsonError("Розбір не знайдено", 404);
  }
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

  // Займаємо генерацію атомарно: якщо дві вкладки прийшли одночасно, генерує лише одна,
  // друга стежить. claimToken — щоб завислий старий виконавець не перезаписав новий.
  const claim = {
    ...rec, status: "generating", text: "", updatedAt: Date.now(),
    attempts: (rec.attempts || 0) + 1, claimToken: crypto.randomUUID(),
  };
  const claimed = await store.setJSON(id, claim, { onlyIfMatch: got.etag });
  if (!claimed?.modified) return new Response(follow(store, id), { headers });

  // Основний шлях: фонова функція (живе до 15 хв, не залежить від браузера),
  // а сторінка лише стежить за записом у Blobs.
  try {
    const bg = await fetch(`${new URL(req.url).origin}/.netlify/functions/generate-background`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, token: claim.claimToken }),
    });
    if (bg.status === 202) return new Response(follow(store, id), { headers });
    console.log("background function unavailable", bg.status);
  } catch (e) {
    console.log("background function call failed", String(e));
  }

  // Запасний шлях: генеруємо прямо тут і стрімимо (обривається разом з браузером).
  let out, clientGone = false, lastSent = 0;
  const stream = new ReadableStream({ start(c) { out = c; }, cancel() { clientGone = true; } });
  const emit = (s) => {
    if (clientGone) return;
    try { out.enqueue(enc.encode(s)); lastSent = Date.now(); } catch { clientGone = true; }
  };
  const job = (async () => {
    emit(HEARTBEAT);
    const beat = setInterval(() => { if (Date.now() - lastSent >= BEAT_MS) emit(HEARTBEAT); }, 1000);
    const r = await generate({ store, id, claim, onText: emit }).catch((e) => {
      console.log("inline generate failed", String(e)); return { ok: false };
    });
    clearInterval(beat);
    if (r.ok) emit(DONE_MARK);
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
