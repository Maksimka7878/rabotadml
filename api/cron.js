const { sendMessage } = require("../lib/telegram");
const { getUpcomingShifts, removePlannedShift } = require("../lib/storage");

module.exports = async function handler(req, res) {
  // Проверка секрета через query-параметр или заголовок
  const secret = req.query.secret || req.headers["x-cron-secret"];
  if (secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const now = Date.now();
    // Окно: от текущего момента до +20 минут
    // Cron запускается каждые 5 минут, окно 20 мин гарантирует что ничего не пропустим
    const windowEnd = now + 20 * 60 * 1000;

    const shifts = await getUpcomingShifts(now, windowEnd);
    let sent = 0;

    for (const shift of shifts) {
      const shiftDate = new Date(shift.timestamp);
      const timeStr = shiftDate.toLocaleString("ru-RU", {
        timeZone: "Europe/Moscow",
        hour: "2-digit",
        minute: "2-digit",
      });

      await sendMessage(
        shift.chatId,
        `⏰ <b>Напоминание!</b>\n\nВаша смена начинается в <b>${timeStr}</b> (МСК)\nОсталось ~15 минут. Готовьтесь! 💪`
      );

      // Удаляем отправленное напоминание
      await removePlannedShift(shift);
      sent++;
    }

    return res.status(200).json({ ok: true, reminders_sent: sent });
  } catch (err) {
    console.error("Cron error:", err);
    return res.status(500).json({ error: err.message });
  }
};
