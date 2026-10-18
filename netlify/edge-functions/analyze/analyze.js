// POST /api/analyze: анкета (індекси) → новий запис розбору в Blobs → { id }.
// Сам розбір генерує /api/report?id=… — так він переживає закриття сторінки
// і доступний за посиланням /r/<id>.
// Якщо пейвол увімкнено (К8), запис створюється як "unpaid": генерація почнеться
// лише після оплати (перевіряє /api/report).
import { buildUserMessage, reports, jsonError, json, creemConfig } from "../../shared/lib.js";

export default async (req) => {
  if (req.method !== "POST") return jsonError("Method not allowed", 405);

  let body;
  try { body = await req.json(); } catch { return jsonError("Bad JSON", 400); }

  const answers = body?.answers;
  if (!buildUserMessage(answers)) return jsonError("Некоректні відповіді", 400);

  const id = crypto.randomUUID();
  try {
    await reports().setJSON(id, {
      answers, status: creemConfig().enabled ? "unpaid" : "new",
      text: "", created: Date.now(), updatedAt: 0, attempts: 0, checkouts: [],
    });
  } catch (e) {
    console.log("blobs write failed", e);
    return jsonError("Не вдалося зберегти відповіді, спробуй ще раз", 500);
  }

  return json({ id });
};

export const config = { path: "/api/analyze" };
