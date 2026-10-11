import { QUESTIONS } from "../../../public/questions.js";

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
    lines.push(`${i + 1}. ${q.label}: ${idx.map((n) => q.opts[n]).join(", ")}`);
  }
  return lines.join("\n");
}

// Пульс: поки модель «думає» (reasoning) і не віддає тексту, з'єднання мовчить,
// і проміжні проксі можуть його обірвати. Тому раз на 3 с шлемо невидимий символ,
// який сторінка викидає.
export const HEARTBEAT = "​";
const BEAT_MS = 3000;

// SSE від OpenRouter → чистий текст (+ пульс)
export function sseToText() {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let buf = "";
  let last = Date.now();
  let timer = null;
  const send = (ctrl, s) => { ctrl.enqueue(enc.encode(s)); last = Date.now(); };
  const handle = (line, ctrl) => {
    line = line.trim();
    if (!line.startsWith("data:")) return; // коментарі ": OPENROUTER PROCESSING" тощо
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    try {
      const j = JSON.parse(data);
      if (j.error) { send(ctrl, "\n\n_[Помилка генерації. Спробуй ще раз.]_"); return; }
      const t = j.choices?.[0]?.delta?.content;
      if (t) send(ctrl, t);
    } catch { /* неповний/службовий рядок — пропускаємо */ }
  };
  return new TransformStream({
    start(ctrl) {
      send(ctrl, HEARTBEAT); // одразу віддати перший байт
      timer = setInterval(() => {
        if (Date.now() - last >= BEAT_MS) {
          try { send(ctrl, HEARTBEAT); } catch { clearInterval(timer); }
        }
      }, 1000);
    },
    transform(chunk, ctrl) {
      buf += dec.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        handle(buf.slice(0, nl), ctrl);
        buf = buf.slice(nl + 1);
      }
    },
    flush(ctrl) { clearInterval(timer); if (buf) handle(buf, ctrl); },
    cancel() { clearInterval(timer); },
  });
}

