const { notifyAdmin } = require("../lib/telegram");
const { scoreLead, formatTgReply } = require("../lib/transcribe");
const { formatNotePlain } = require("../lib/transcribe");
const { getAnalysis, updateAnalysisScore } = require("../lib/storage");

async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  const { analysisId, managerName } = req.body;
  if (!analysisId) return res.status(400).json({ error: "missing analysisId" });

  res.status(200).json({ ok: true });

  try {
    const record = await getAnalysis(analysisId);
    if (!record || !record.transcription) {
      await notifyAdmin(`⚠️ Транскрипция не найдена (id=${analysisId})`);
      return;
    }

    const transcription = record.transcription;
    let score;
    try {
      score = await scoreLead(transcription, process.env.GEMINI_API_KEY);
    } catch (e) {
      await notifyAdmin(`⚠️ Ошибка оценки звонка (${managerName}): ${e.message}`);
      return;
    }

    await updateAnalysisScore(analysisId, score);
    await notifyAdmin(`📊 ${formatTgReply(transcription, score, managerName)}`);
  } catch (e) {
    console.error("[score] fatal:", e.message);
    await notifyAdmin(`⚠️ Критическая ошибка оценки (${managerName}): ${e.message}`).catch(() => {});
  }
}

module.exports = handler;
module.exports.config = { maxDuration: 60 };
