const { GoogleGenerativeAI } = require("@google/generative-ai");

const MODEL_NAME = "gemini-2.0-flash-lite";
const FALLBACK_MODELS = ["gemini-2.0-flash", "gemini-2.5-flash"];

const TRANSCRIPTION_PROMPT = `Прослушай аудиозапись телефонного разговора и верни ТОЛЬКО JSON без markdown:
{
  "duration_seconds": <число>,
  "summary": "<краткое резюме 1-2 предложения>",
  "full_text": "<весь текст разговора>"
}`;

const SCORING_PROMPT = `Оцени лид для брокера новостроек по тексту звонка. Верни ТОЛЬКО JSON без markdown:
{
  "score": <0-100>,
  "grade": "Идеальный" (95-100) | "Горячий" (80-94) | "Хороший" (70-79) | "Нормальный" (65-69) | "Не очень" (<65),
  "бюджет": "<или null>",
  "локация": "<или null>",
  "комнатность": "<или null>",
  "срок_покупки": "<или null>",
  "тип_жилья": "новостройка" | "вторичка" | "не определено",
  "recommendation": "<1 предложение>"
}`;

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

const COMBINED_PROMPT = `${TRANSCRIPTION_PROMPT}

---

После транскрипции выполни оценку лида по следующим критериям:

${SCORING_PROMPT}

Верни строго JSON с двумя ключами:
{
  "transcription": { ...объект транскрипции... },
  "score": { ...объект оценки... }
}`;

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
      TRANSCRIPTION_PROMPT,
      { inlineData: { mimeType: "audio/mpeg", data: base64Audio } },
    ]).then(r => r.response.text())
  );
  return JSON.parse(cleanJson(raw));
}

async function scoreLead(transcription, apiKey) {
  const key = apiKey || process.env.GEMINI_API_KEY;
  const genAI = new GoogleGenerativeAI(key);
  const dialog = (transcription.segments || []).map(s => `[${s.start}] ${s.speaker}: ${s.text}`).join("\n");
  const content = `ДИАЛОГ:\n${dialog}\n\nПОЛНЫЙ ТЕКСТ:\n${transcription.full_text || ""}`;
  const raw = await tryModels(genAI, model =>
    model.generateContent([SCORING_PROMPT, content]).then(r => r.response.text())
  );
  return JSON.parse(cleanJson(raw));
}

function formatDuration(seconds) {
  if (!seconds) return "?";
  const m = Math.floor(seconds / 60);
  const s = String(seconds % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function formatTgReply(transcription, score) {
  const gradeEmoji = { "Идеальный": "💎", "Горячий": "🔥", "Хороший": "✅", "Нормальный": "🌤", "Не очень": "❄️" }[score.grade] || "";
  return [
    `${gradeEmoji} <b>Оценка: ${score.score}/100 — ${score.grade}</b>`,
    "",
    `🕐 Длительность: ${formatDuration(transcription.duration_seconds)}`,
    `📝 ${transcription.summary || "—"}`,
    "",
    `💰 Бюджет: ${score["бюджет"] || "—"}`,
    `📍 Локация: ${score["локация"] || "—"}`,
    `🛏 Комнатность: ${score["комнатность"] || "—"}`,
    `📅 Срок покупки: ${score["срок_покупки"] || "—"}`,
    `🏗 Тип жилья: ${score["тип_жилья"] || "—"}`,
    "",
    `💡 <i>${score.recommendation || ""}</i>`,
  ].join("\n");
}

module.exports = { analyzeBuffer, transcribeBuffer, scoreLead, formatTgReply };
