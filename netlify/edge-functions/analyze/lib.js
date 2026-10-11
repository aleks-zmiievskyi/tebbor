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

// SSE від OpenRouter → чистий текст
export function sseToText() {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let buf = "";
  const handle = (line, ctrl) => {
    line = line.trim();
    if (!line.startsWith("data:")) return; // коментарі ": OPENROUTER PROCESSING" тощо
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    try {
      const j = JSON.parse(data);
      if (j.error) { ctrl.enqueue(enc.encode("\n\n_[Помилка генерації. Спробуй ще раз.]_")); return; }
      const t = j.choices?.[0]?.delta?.content;
      if (t) ctrl.enqueue(enc.encode(t));
    } catch { /* неповний/службовий рядок — пропускаємо */ }
  };
  return new TransformStream({
    transform(chunk, ctrl) {
      buf += dec.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        handle(buf.slice(0, nl), ctrl);
        buf = buf.slice(nl + 1);
      }
    },
    flush(ctrl) { if (buf) handle(buf, ctrl); },
  });
}

