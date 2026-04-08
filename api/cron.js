const { sendMessage, notifyAdmin } = require("../lib/telegram");
const { initTables, getUpcomingShifts, removePlannedShift } = require("../lib/storage");

let tablesReady = false;

module.exports = async function handler(req, res) {
  // Защита: принимаем только от Vercel Cron (заголовок Authorization)
  const authHeader = req.headers["authorization"];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  if (!tablesReady) {
    await initTables();
    tablesReady = true;
  }

  try {
    const now = Date.now();
    // Окно: от текущего момента до +20 минут (ловим смены за 15 минут до старта)
    const windowEnd = now + 20 * 60 * 1000;
    const shifts = await getUpcomingShifts(now, windowEnd);

    for (const shift of shifts) {
      const shiftDate = new Date(shift.timestamp);
      const timeStr = shiftDate.toLocaleString("ru-RU", {
        timeZone: "Europe/Moscow",
        hour: "2-digit",
        minute: "2-digit",
      });

      // Уведомление менеджеру
      await sendMessage(
        shift.chatId,
        `⏰ <b>Напоминание!</b>\n\nВаша смена начинается в <b>${timeStr}</b> (МСК)\nОсталось ~15 минут. Готовьтесь! 🔥`
      );

      // Уведомление администратору
      await notifyAdmin(
        `⏰ <b>${shift.userName}</b> выходит на смену в <b>${timeStr}</b> (МСК)\nНапоминание отправлено менеджеру.`
      );

      await removePlannedShift(shift);
    }

    return res.status(200).json({ ok: true, processed: shifts.length });
  } catch (err) {
    console.error("Cron reminder error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
