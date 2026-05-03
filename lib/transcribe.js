const { GoogleGenerativeAI } = require("@google/generative-ai");

const MODEL_NAME = "gemini-3.1-flash-lite-preview";
const FALLBACK_MODELS = ["gemini-2.5-flash", "gemini-2.0-flash-lite"];

const SYSTEM_PROMPT = `Ты помогаешь команде брокеров делать суммарайзы и оценки лидов по транскрибациям звонков менеджеров с клиентами.
Бизнес-контекст: компания продаёт новостройки Москвы — бизнес, премиум, делюкс-класс, старты продаж и ранние стадии строительства.

### Суммарайз
Поле summary. Начинается с фразы: «При заходе сказать, что звонил(а) ваш личный ассистент [имя менеджера из записи], передал(а), что:»
Сплошной текст абзацами через \\n\\n. Порядок: цель → формат/площадь → локация → бюджет/оплата → срок сдачи/срочность → что смотрел/отверг/понравилось → доп. требования → контакт.
Только факты из разговора. Не додумывать, не усиливать, не смягчать. Без рекомендаций брокеру.

### Оценка
Поле score — целое число от 5 до 95.
Шкала: 80–95 — высокий бюджет, чёткий запрос, готов к сделке / 65–79 — хороший запрос, но 1–2 ограничивающих фактора / 50–64 — запрос частичный, бюджет пограничный / 35–49 — слабая мотивация, ранняя стадия / 5–30 — нецелевой контакт.
Поле pros — факторы соответствия: бюджет, класс, срочность, соответствие профилю стартов продаж, конкретность запроса.
Поле cons — ограничивающие факторы: низкий/неизвестный бюджет, только готовые объекты, зависимость от продажи своей недвижимости, нереалистичные ожидания, низкая вовлечённость.

### Формат вывода
Отвечай строго в JSON без markdown, без пояснений:
{
  "duration_seconds": <число>,
  "client_name": "<имя клиента>",
  "summary": "При заходе сказать, что звонил(а) ваш личный ассистент [имя], передал(а), что:\\n\\n[текст]",
  "score": <5-95>,
  "pros": "<текст>",
  "cons": "<текст>"
}`;

function cleanJson(raw) {
  if (raw.includes("```")) {
    raw = raw.split("\n").filter(l => !l.trim().startsWith("```")).join("\n").trim();
  }
  return raw.trim();
}

async function tryModels(genAI, fn) {
  const models = [MODEL_NAME, ...FALLBACK_MODELS];
  for (let i = 0; i < models.length; i++) {
    try {
      const model = genAI.getGenerativeModel({
        model: models[i],
        generationConfig: { temperature: 0.1, maxOutputTokens: 8192 },
      });
      return await fn(model);
    } catch (e) {
      if (i === models.length - 1) throw e;
    }
  }
}

async function analyzeBuffer(audioBuffer, apiKey) {
  const key = apiKey || process.env.GEMINI_API_KEY;
  const genAI = new GoogleGenerativeAI(key);
  const base64Audio = audioBuffer.toString("base64");
  const raw = await tryModels(genAI, model =>
    model.generateContent([
      SYSTEM_PROMPT,
      { inlineData: { mimeType: "audio/mpeg", data: base64Audio } },
    ]).then(r => r.response.text())
  );
  return JSON.parse(cleanJson(raw));
}

async function transcribeBuffer(audioBuffer, apiKey) {
  return analyzeBuffer(audioBuffer, apiKey);
}

async function scoreLead(result, apiKey) {
  const key = apiKey || process.env.GEMINI_API_KEY;
  const genAI = new GoogleGenerativeAI(key);
  const content = `ТЕКСТ РАЗГОВОРА:\n${result.full_text || result.summary || ""}`;
  const raw = await tryModels(genAI, model =>
    model.generateContent([SYSTEM_PROMPT, content]).then(r => r.response.text())
  );
  return JSON.parse(cleanJson(raw));
}

function formatDuration(seconds) {
  if (!seconds) return "?";
  const m = Math.floor(seconds / 60);
  const s = String(seconds % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function formatTgReply(result, _score, _managerName) {
  const r = result;
  const clientName = r.client_name || "клиент";
  const scoreVal = r.score ?? (_score?.score ?? "?");

  const lines = [
    `<b>Суммарайз лида: ${clientName}</b>  🕐 ${formatDuration(r.duration_seconds)}`,
    "",
    r.summary || "—",
    "",
    "─────────────────",
    "",
    `<b>Оценка привлекательности лида для брокера: ${scoreVal}%</b>`,
  ];

  if (r.pros) lines.push(`Факторы соответствия: ${r.pros}`);
  if (r.cons) lines.push(`Ограничивающие факторы: ${r.cons}`);

  return lines.join("\n");
}

function formatNotePlain(result, _score, _managerName) {
  const r = result;
  const clientName = r.client_name || "клиент";
  const scoreVal = r.score ?? (_score?.score ?? "?");

  return [
    `Суммарайз лида: ${clientName}  Длительность: ${formatDuration(r.duration_seconds)}`,
    "",
    r.summary || "—",
    "",
    `Оценка привлекательности лида для брокера: ${scoreVal}%`,
    r.pros ? `Факторы соответствия: ${r.pros}` : "",
    r.cons ? `Ограничивающие факторы: ${r.cons}` : "",
  ].filter(Boolean).join("\n");
}

module.exports = { analyzeBuffer, transcribeBuffer, scoreLead, formatTgReply, formatNotePlain };
