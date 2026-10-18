// POST /api/analyze: анкета (індекси) → новий запис розбору в Blobs → { id }.
// Сам розбір генерує /api/report?id=… — так він переживає закриття сторінки
// і доступний за посиланням /r/<id>.
// TODO К8: тут же створювати checkout у creem, а генерувати — лише після оплати.
import { buildUserMessage, reports, jsonError } from "../../shared/lib.js";

export default async (req) => {
  if (req.method !== "POST") return jsonError("Method not allowed", 405);

  let body;
  try { body = await req.json(); } catch { return jsonError("Bad JSON", 400); }

  const answers = body?.answers;
  if (!buildUserMessage(answers)) return jsonError("Некоректні відповіді", 400);

  const id = crypto.randomUUID();
  try {
    await reports().setJSON(id, {
      answers, status: "new", text: "", created: Date.now(), updatedAt: 0, attempts: 0,
    });
  } catch (e) {
    console.log("blobs write failed", e);
    return jsonError("Не вдалося зберегти відповіді, спробуй ще раз", 500);
  }

  return new Response(JSON.stringify({ id }), {
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
};

export const config = { path: "/api/analyze" };
