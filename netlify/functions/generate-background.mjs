// Фонова функція Netlify (суфікс -background): живе до 15 хв незалежно від браузера.
// Її викликає /api/report після того, як «зайняв» розбір; токен із Blobs не дає
// запустити генерацію ззовні.
import { reports, ID_RE } from "../shared/lib.js";
import { generate } from "../shared/generate.js";

export default async (req) => {
  let body;
  try { body = await req.json(); } catch { return; }
  const id = String(body?.id || "");
  const token = String(body?.token || "");
  if (!ID_RE.test(id) || !token) return;

  const store = reports();
  const claim = await store.get(id, { type: "json" }).catch(() => null);
  if (!claim || claim.status !== "generating" || claim.claimToken !== token) {
    console.log("generate-background: stale or foreign claim", id);
    return;
  }
  const r = await generate({ store, id, claim });
  console.log("generate-background done", id, JSON.stringify(r));
};
