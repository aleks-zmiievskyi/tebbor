// POST /api/checkout { id } → створює checkout у creem для цього розбору → { checkout_url }.
// Після оплати creem повертає людину на /r/<id>, а /api/report сам перевіряє оплату в creem
// (клієнту не віримо).
import { reports, ID_RE, jsonError, json, creemConfig, creemCreateCheckout } from "../../shared/lib.js";

export default async (req) => {
  if (req.method !== "POST") return jsonError("Method not allowed", 405);
  let body;
  try { body = await req.json(); } catch { return jsonError("Bad JSON", 400); }
  const id = String(body?.id || "");
  if (!ID_RE.test(id)) return jsonError("Розбір не знайдено", 404);

  const cfg = creemConfig();
  if (!cfg.enabled) return jsonError("Оплата зараз вимкнена", 409);

  const store = reports();
  const rec = await store.get(id, { type: "json" });
  if (!rec) return jsonError("Розбір не знайдено", 404);
  if (rec.status !== "unpaid") return json({ paid: true });

  let co;
  try {
    co = await creemCreateCheckout(cfg, id, `${new URL(req.url).origin}/r/${id}`);
  } catch (e) {
    console.log(String(e));
    return jsonError("Платіжка недоступна, спробуй за хвилину", 502);
  }
  if (!co?.checkout_url || !co?.id) return jsonError("Платіжка недоступна, спробуй за хвилину", 502);

  // Пам'ятаємо останні checkout-и: людина могла відкрити оплату кілька разів.
  const checkouts = [co.id, ...(rec.checkouts || []).filter((x) => x !== co.id)].slice(0, 5);
  await store.setJSON(id, { ...rec, checkouts }).catch((e) => console.log("save checkout failed", e));

  return json({ checkout_url: co.checkout_url });
};

export const config = { path: "/api/checkout" };
