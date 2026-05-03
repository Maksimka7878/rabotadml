const { GoogleGenerativeAI } = require("@google/generative-ai");

const MODEL_NAME = "gemini-2.0-flash-lite";
const FALLBACK_MODELS = ["gemini-2.0-flash", "gemini-2.5-flash"];

const COMBINED_PROMPT = `Ты помогаешь команде брокеров по недвижимости делать суммарайзы и оценки лидов на основе транскрибаций телефонных диалогов менеджеров с клиентами.
Контекст бизнеса: компания продаёт новостройки Москвы — преимущественно бизнес, премиум и делюкс-класс, старты продаж и ранние стадии строительства.

Прослушай аудиозапись и верни ТОЛЬКО JSON без markdown:
{
  "transcription": {
    "duration_seconds": <число>,
    "manager_name": "<имя менеджера из разговора>",
    "client_name": "<имя клиента из разговора>",
    "summary": "<суммарайз — сплошной текст абзацами, без маркированных списков и жирных подзаголовков. Каждый абзац — отдельная смысловая группа. Порядок: цель и мотивация → формат и площадь → локация → бюджет и форма оплаты → срок сдачи и срочность → что смотрел, что понравилось, что нет и почему → доп. требования → контакт (мессенджер, время, имя брокера). Только то, что прямо сказано, ничего не додумывать. Не усиливать и не смягчать.>"
  },
  "score": {
    "score": <5-95, число>,
    "factors": "<факторы соответствия: бюджет, класс жилья, срочность, соответствие профилю стартов продаж бизнес/премиум, конкретность запроса>",
    "limiting_factors": "<ограничивающие факторы: низкий или неизвестный бюджет, ориентация только на готовые объекты, зависимость от продажи другой недвижимости, нереалистичные ожидания, низкая вовлечённость>"
  }
}

Шкала оценки score:
80–95 — высокий бюджет (от ~50 млн), чёткий запрос, готов к сделке в ближайшее время
65–79 — хороший бюджет или чёткий запрос, но 1–2 ограничивающих фактора
50–64 — запрос частично сформирован, бюджет пограничный или неизвестен
35–49 — слабая мотивация, бюджет не соответствует запросу
5–30 — нецелевой контакт, нет признаков готовности к сделке`;

function cleanJson(raw) {
  if (raw.startsWith("```")) {
    raw = raw.split("\n").filter(l => !l.trim().startsWith("```")).join("\n").trim();
  }
  return raw;
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
      COMBINED_PROMPT,
      { inlineData: { mimeType: "audio/mpeg", data: base64Audio } },
    ]).then(r => r.response.text())
  );
  const result = JSON.parse(cleanJson(raw));
  return { transcription: result.transcription, score: result.score };
}

async function transcribeBuffer(audioBuffer, apiKey) {
  const key = apiKey || process.env.GEMINI_API_KEY;
  const genAI = new GoogleGenerativeAI(key);
  const base64Audio = audioBuffer.toString("base64");
  const raw = await tryModels(genAI, model =>
    model.generateContent([
      COMBINED_PROMPT,
      { inlineData: { mimeType: "audio/mpeg", data: base64Audio } },
    ]).then(r => r.response.text())
  );
  const result = JSON.parse(cleanJson(raw));
  return result.transcription;
}

async function scoreLead(transcription, apiKey) {
  const key = apiKey || process.env.GEMINI_API_KEY;
  const genAI = new GoogleGenerativeAI(key);
  const content = `ПОЛНЫЙ ТЕКСТ РАЗГОВОРА:\n${transcription.full_text || transcription.summary || ""}`;
  const scorePrompt = `${COMBINED_PROMPT}\n\nНа основе текста (без аудио) верни только объект score:\n{"score": <5-95>, "factors": "...", "limiting_factors": "..."}`;
  const raw = await tryModels(genAI, model =>
    model.generateContent([scorePrompt, content]).then(r => r.response.text())
  );
  return JSON.parse(cleanJson(raw));
}

function formatDuration(seconds) {
  if (!seconds) return "?";
  const m = Math.floor(seconds / 60);
  const s = String(seconds % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function formatTgReply(transcription, score, managerName) {
  const clientName = transcription.client_name || "клиент";
  const mgr = transcription.manager_name || managerName || "ассистент";

  const lines = [
    `<b>Суммарайз лида: ${clientName}</b>`,
    `<i>🕐 ${formatDuration(transcription.duration_seconds)}</i>`,
    "",
    `При заходе сказать, что звонил(а) ваш личный ассистент ${mgr}, передал(а), что:`,
    "",
    transcription.summary || "—",
    "",
    "─────────────────",
    "",
    `<b>Оценка привлекательности лида для брокера: ${score.score}%</b>`,
  ];

  if (score.factors) {
    lines.push(`Факторы соответствия: ${score.factors}`);
  }
  if (score.limiting_factors) {
    lines.push(`Ограничивающие факторы: ${score.limiting_factors}`);
  }

  return lines.join("\n");
}

function formatNotePlain(transcription, score, managerName) {
  const clientName = transcription.client_name || "клиент";
  const mgr = transcription.manager_name || managerName || "ассистент";
  return [
    `Суммарайз лида: ${clientName}`,
    `Длительность: ${formatDuration(transcription.duration_seconds)}`,
    "",
    `При заходе сказать, что звонил(а) ваш личный ассистент ${mgr}, передал(а), что:`,
    "",
    transcription.summary || "—",
    "",
    `Оценка привлекательности лида для брокера: ${score.score}%`,
    score.factors ? `Факторы соответствия: ${score.factors}` : "",
    score.limiting_factors ? `Ограничивающие факторы: ${score.limiting_factors}` : "",
  ].filter(l => l !== undefined).join("\n");
}

module.exports = { analyzeBuffer, transcribeBuffer, scoreLead, formatTgReply, formatNotePlain };
