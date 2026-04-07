const { sendMessage, notifyAdmin, mainMenu } = require("../lib/telegram");
const {
  getUser,
  setUser,
  getShift,
  setShift,
  deleteShift,
  addPlannedShift,
  getUpcomingShifts,
  removePlannedShift,
} = require("../lib/storage");

function mskNow() {
  return new Date().toLocaleString("ru-RU", { timeZone: "Europe/Moscow" });
}

function parseTomorrowMsk(hours, minutes) {
  const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
  const nowUtc = Date.now();
  const nowMsk = new Date(nowUtc + MSK_OFFSET_MS);

  const tomorrow = new Date(nowMsk);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(hours, minutes, 0, 0);

  // конвертируем обратно в UTC timestamp
  return tomorrow.getTime() - MSK_OFFSET_MS;
}

// --- Обработка /start ---
async function handleStart(chatId) {
  await setUser(chatId, { state: "awaiting_name" });
  await sendMessage(
    chatId,
    "👋 <b>Добро пожаловать!</b>\n\nВведите ваше имя для авторизации:"
  );
}

// --- Ввод имени ---
async function handleNameInput(chatId, text, user) {
  user.name = text;
  user.state = "authorized";
  await setUser(chatId, user);
  await sendMessage(
    chatId,
    `✅ Вы авторизованы как <b>${text}</b>`,
    mainMenu()
  );
  await notifyAdmin(`📋 Новый сотрудник авторизован: <b>${text}</b>`);
}

// --- Ввод времени планируемой смены ---
async function handlePlanTimeInput(chatId, text, user) {
  const match = text.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    await sendMessage(
      chatId,
      "❌ Неверный формат. Введите время в формате <b>ЧЧ:ММ</b> (например, <code>09:00</code>):"
    );
    return;
  }

  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);

  if (hours > 23 || minutes > 59) {
    await sendMessage(
      chatId,
      "❌ Неверное время. Введите время в формате <b>ЧЧ:ММ</b>:"
    );
    return;
  }

  const plannedUtcMs = parseTomorrowMsk(hours, minutes);
  await addPlannedShift(chatId, plannedUtcMs, user.name);

  user.state = "authorized";
  await setUser(chatId, user);

  const timeStr = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  await sendMessage(
    chatId,
    `✅ Смена запланирована на завтра в <b>${timeStr}</b> (МСК)\n\n⏰ Вам придёт напоминание за 15 минут.`,
    mainMenu()
  );
  await notifyAdmin(
    `📅 <b>${user.name}</b> планирует выйти на смену завтра в <b>${timeStr}</b> (МСК)`
  );
}

// --- Кнопки меню ---
async function handleMenuButton(chatId, text, user) {
  switch (text) {
    case "🟢 Выйти на смену": {
      const existing = await getShift(chatId);
      if (existing && existing.active) {
        await sendMessage(chatId, "⚠️ Вы уже на смене!", mainMenu());
        return;
      }
      const startTime = mskNow();
      await setShift(chatId, { active: true, startTime });
      await sendMessage(
        chatId,
        `🟢 Смена начата!\n\n🕐 <b>${startTime}</b> (МСК)\n\nХорошей работы! 💪`,
        mainMenu()
      );
      await notifyAdmin(
        `🟢 <b>${user.name}</b> вышел на смену\n🕐 ${startTime} (МСК)`
      );
      return;
    }

    case "🔴 Завершить смену": {
      const shift = await getShift(chatId);
      if (!shift || !shift.active) {
        await sendMessage(chatId, "⚠️ Вы сейчас не на смене.", mainMenu());
        return;
      }
      const endTime = mskNow();
      await deleteShift(chatId);
      await sendMessage(
        chatId,
        `🔴 Смена завершена!\n\n🕐 Начало: <b>${shift.startTime}</b>\n🕐 Конец: <b>${endTime}</b> (МСК)\n\nСпасибо за работу! 👏`,
        mainMenu()
      );
      await notifyAdmin(
        `🔴 <b>${user.name}</b> завершил смену\n🕐 Начало: ${shift.startTime}\n🕐 Конец: ${endTime} (МСК)`
      );
      return;
    }

    case "📅 Запланировать смену": {
      user.state = "awaiting_plan_time";
      await setUser(chatId, user);
      await sendMessage(
        chatId,
        "🕐 Введите время выхода на завтрашнюю смену в формате <b>ЧЧ:ММ</b>\n\nНапример: <code>09:00</code>",
        {
          reply_markup: {
            keyboard: [[{ text: "❌ Отмена" }]],
            resize_keyboard: true,
          },
        }
      );
      return;
    }

    case "⭐ Квал лид": {
      await sendMessage(
        chatId,
        "✅ Уведомление отправлено руководителю!",
        mainMenu()
      );
      await notifyAdmin(
        `⭐⭐⭐ <b>КВАЛ ЛИД</b>\n\nОт сотрудника: <b>${user.name}</b>\n🕐 ${mskNow()} (МСК)`
      );
      return;
    }

    case "❌ Отмена": {
      user.state = "authorized";
      await setUser(chatId, user);
      await sendMessage(chatId, "↩️ Действие отменено.", mainMenu());
      return;
    }

    default: {
      await sendMessage(chatId, "Используйте кнопки меню 👇", mainMenu());
    }
  }
}

// --- Проверка и отправка напоминаний (при каждом запросе) ---
async function checkReminders() {
  try {
    const now = Date.now();
    const windowEnd = now + 20 * 60 * 1000; // 20 минут вперёд

    const shifts = await getUpcomingShifts(now, windowEnd);

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
      await notifyAdmin(
        `⏰ Напоминание отправлено <b>${shift.userName}</b> — смена в <b>${timeStr}</b> (МСК)`
      );
      await removePlannedShift(shift);
    }
  } catch (err) {
    console.error("Reminder check error:", err);
  }
}

// --- Vercel handler ---
module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).json({ ok: true, info: "Bot is running" });
  }

  const update = req.body;
  const message = update && update.message;

  // Проверяем напоминания при каждом входящем сообщении
  await checkReminders();

  if (!message || !message.text) {
    return res.status(200).json({ ok: true });
  }

  const chatId = message.chat.id;
  const text = message.text.trim();

  try {
    if (text === "/start") {
      await handleStart(chatId);
      return res.status(200).json({ ok: true });
    }

    const user = await getUser(chatId);

    if (!user) {
      await sendMessage(
        chatId,
        "👋 Нажмите /start для начала работы."
      );
      return res.status(200).json({ ok: true });
    }

    if (user.state === "awaiting_name") {
      await handleNameInput(chatId, text, user);
    } else if (user.state === "awaiting_plan_time") {
      await handlePlanTimeInput(chatId, text, user);
    } else {
      await handleMenuButton(chatId, text, user);
    }
  } catch (err) {
    console.error("Webhook error:", err);
    await sendMessage(chatId, "❌ Произошла ошибка. Попробуйте позже.").catch(
      () => {}
    );
  }

  return res.status(200).json({ ok: true });
};
