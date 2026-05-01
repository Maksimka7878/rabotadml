const { GoogleGenerativeAI } = require("@google/generative-ai");

const MODEL_NAME = "gemini-2.0-flash-lite";
const FALLBACK_MODELS = ["gemini-2.0-flash", "gemini-2.5-flash"];

const TRANSCRIPTION_PROMPT = `Ты — профессиональный транскрибатор телефонных разговоров.

Твоя задача — полностью транскрибировать данную аудиозапись.

Формат ответа — строго JSON:
{
  "duration_seconds": <общая длительность в секундах>,
  "speakers_count": <количество уникальных спикеров>,
  "language": "<определённый язык>",
  "segments": [
    {
      "start": "<MM:SS>",
      "end":   "<MM:SS>",
      "speaker": "Менеджер" | "Клиент",
      "text": "<точный текст фразы>"
    }
  ],
  "full_text": "<весь текст разговора одним блоком>",
  "summary": "<краткое резюме разговора 2-3 предложения>"
}

Требования:
- Фиксируй КАЖДУЮ фразу, даже короткие реплики («угу», «да», «хорошо»).
- Различай спикеров по роли: тот кто предлагает/продаёт — "Менеджер", тот кому звонят — "Клиент".
- Временны́е метки — формат MM:SS.
- Текст передавай дословно, сохраняй разговорный стиль, слова-паразиты, паузы (...).
- Если слово неразборчиво — пиши [неразборчиво].
- Отвечай ТОЛЬКО валидным JSON, без markdown-блоков и пояснений.`;

const SCORING_PROMPT = `Ты — эксперт по оценке лидов для брокера новостроек.

Тебе дана транскрипция телефонного разговора. Оцени лид от 0 до 100.

Идеальный лид (100 баллов) = клиент ищет новостройку, чётко назвал:
- бюджет
- локацию
- площадь / комнатность
- срок сдачи
- готов к покупке в ближайшее время
- охотно общается, заинтересован

Критерии и веса:
1. Интерес к новостройке (не вторичка) — до 20 баллов
2. Бюджет назван чётко — до 20 баллов (частично = 5-10)
3. Локация определена — до 15 баллов (примерно = 5-8)
4. Площадь / комнатность названы — до 15 баллов
5. Срок покупки — до 15 баллов (чем быстрее, тем выше)
6. Готовность к контакту / вовлечённость — до 10 баллов
7. Нет жёсткого отказа, диалог состоялся — до 5 баллов

Ответь строго JSON:
{
  "score": <0-100>,
  "grade": "Горячий" | "Тёплый" | "Холодный" | "Мусор",
  "criteria": {
    "новостройка": <0-20>,
    "бюджет": <0-20>,
    "локация": <0-15>,
    "площадь_комнатность": <0-15>,
    "срок_покупки": <0-15>,
    "вовлечённость": <0-10>,
    "контакт_состоялся": <0-5>
  },
  "extracted": {
    "бюджет": "<сумма или null>",
    "локация": "<локация или null>",
    "площадь": "<диапазон или null>",
    "комнатность": "<кол-во комнат или null>",
    "срок_сдачи": "<срок или null>",
    "тип_жилья": "новостройка" | "вторичка" | "не определено"
  },
  "strengths": ["<сильная сторона лида>"],
  "weaknesses": ["<слабая сторона лида>"],
  "recommendation": "<1-2 предложения: стоит ли брать лид и почему>"
}

Отвечай ТОЛЬКО валидным JSON, без markdown и пояснений.`;

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

  const dialog = (transcription.segments || [])
    .map(s => `[${s.start}] ${s.speaker}: ${s.text}`)
    .join("\n");
  const content = `ДИАЛОГ:\n${dialog}\n\nПОЛНЫЙ ТЕКСТ:\n${transcription.full_text || ""}`;

  const raw = await tryModels(genAI, model =>
    model.generateContent([SCORING_PROMPT, content]).then(r => r.response.text())
  );
  return JSON.parse(cleanJson(raw));
}

function formatTgReply(transcription, score) {
  const gradeEmoji = { "Горячий": "🔥", "Тёплый": "🌤", "Холодный": "🧊", "Мусор": "🗑" }[score.grade] || "";
  const ex = score.extracted || {};
  const strengths = (score.strengths || []).map(s => `  ✅ ${s}`).join("\n");
  const weaknesses = (score.weaknesses || []).map(w => `  ❌ ${w}`).join("\n");

  return [
    `${gradeEmoji} <b>Оценка лида: ${score.score}/100 — ${score.grade}</b>`,
    "",
    `💰 Бюджет: ${ex["бюджет"] || "—"}`,
    `📍 Локация: ${ex["локация"] || "—"}`,
    `📐 Площадь: ${ex["площадь"] || "—"}`,
    `🛏 Комнатность: ${ex["комнатность"] || "—"}`,
    `📅 Срок сдачи: ${ex["срок_сдачи"] || "—"}`,
    `🏗 Тип жилья: ${ex["тип_жилья"] || "—"}`,
    "",
    `🕐 Длит. разговора: ${transcription.duration_seconds || "?"} сек`,
    "",
    strengths,
    weaknesses,
    "",
    `💡 <i>${score.recommendation || ""}</i>`,
  ].join("\n");
}

module.exports = { transcribeBuffer, scoreLead, formatTgReply };
