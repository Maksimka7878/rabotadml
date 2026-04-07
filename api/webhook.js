const { sendMessage, notifyAdmin, mainMenu, onShiftMenu, adminMenu } = require("../lib/telegram");
const {
  initTables,
  getUser,
  setUser,
  getShift,
  setShift,
  deleteShift,
  incrementQualLeads,
  logShift,
  getStats,
  getActiveShiftsWithNames,
  addPlannedShift,
  getUpcomingShifts,
  removePlannedShift,
} = require("../lib/storage");

let tablesReady = false;

function mskNow() {
  return new Date().toLocaleString("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function parseTomorrowMsk(hours, minutes) {
  const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
  const nowUtc = Date.now();
  const nowMsk = new Date(nowUtc + MSK_OFFSET_MS);

  const tomorrow = new Date(nowMsk);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(hours, minutes, 0, 0);

  return tomorrow.getTime() - MSK_OFFSET_MS;
}

// Начало сегодняшнего дня по МСК в UTC ms
function todayStartMs() {
  const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
  const nowMsk = new Date(Date.now() + MSK_OFFSET_MS);
  const start = new Date(nowMsk);
  start.setHours(0, 0, 0, 0);
  return start.getTime() - MSK_OFFSET_MS;
}

// Начало текущей недели (понедельник) по МСК в UTC ms
function weekStartMs() {
  const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
  const nowMsk = new Date(Date.now() + MSK_OFFSET_MS);
  const day = nowMsk.getDay();
  const diff = day === 0 ? 6 : day - 1; // понедельник = 0
  const start = new Date(nowMsk);
  start.setDate(start.getDate() - diff);
  start.setHours(0, 0, 0, 0);
  return start.getTime() - MSK_OFFSET_MS;
}

// Хелпер для выбора меню с учётом админа
function checkAdmin(chatId) {
  const adminId = process.env.ADMIN_CHAT_ID;
  return adminId && String(chatId) === String(adminId).trim();
}

function getMenu(chatId, onShift) {
  if (checkAdmin(chatId)) return adminMenu();
  return onShift ? onShiftMenu() : mainMenu();
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
    getMenu(chatId, false)
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
    getMenu(chatId, false)
  );
  await notifyAdmin(
    `📅 <b>${user.name}</b> планирует выйти на смену завтра в <b>${timeStr}</b> (МСК)`
  );
}

// Форматирование статистики
async function formatStats(fromMs, periodName) {
  const stats = await getStats(fromMs);
  const active = await getActiveShiftsWithNames();

  if (stats.length === 0 && active.length === 0) {
    return `📊 <b>Статистика ${periodName}</b>\n\nНет данных.`;
  }

  let text = `📊 <b>Статистика ${periodName}</b>\n`;

  if (active.length > 0) {
    text += `\n🟢 <b>Сейчас на смене:</b>\n`;
    for (const s of active) {
      text += `  • ${s.name} (с ${s.start_time}, квал: ${s.qual_leads || 0})\n`;
    }
  }

  if (stats.length > 0) {
    text += `\n📋 <b>Завершённые смены:</b>\n`;
    let totalShifts = 0;
    let totalQual = 0;
    for (const s of stats) {
      text += `  • <b>${s.user_name}</b> — смен: ${s.total_shifts}, квал лидов: ${s.total_qual_leads}\n`;
      totalShifts += Number(s.total_shifts);
      totalQual += Number(s.total_qual_leads);
    }
    text += `\n<b>Итого:</b> ${totalShifts} смен, ${totalQual} квал лидов`;
  }

  return text;
}

// --- Кнопки меню ---
async function handleMenuButton(chatId, text, user) {
  switch (text) {
    case "🟢 Выйти на смену": {
      const existing = await getShift(chatId);
      if (existing && existing.active) {
        await sendMessage(chatId, "⚠️ Вы уже на смене!", getMenu(chatId, true));
        return;
      }
      const startTime = mskNow();
      await setShift(chatId, { active: true, startTime, qualLeads: 0 });
      await sendMessage(
        chatId,
        `🟢 Смена начата!\n\n🕐 <b>${startTime}</b> (МСК)\n\nХорошей работы! 💪`,
        getMenu(chatId, true)
      );
      await notifyAdmin(
        `🟢 <b>${user.name}</b> вышел на смену\n🕐 ${startTime} (МСК)`
      );
      return;
    }

    case "🔴 Завершить смену": {
      const shift = await getShift(chatId);
      if (!shift || !shift.active) {
        await sendMessage(chatId, "⚠️ Вы сейчас не на смене.", getMenu(chatId, false));
        return;
      }
      const endTime = mskNow();
      const qualLeads = shift.qual_leads || 0;
      await logShift(chatId, user.name, shift.start_time, endTime, qualLeads);
      await deleteShift(chatId);
      await sendMessage(
        chatId,
        `🔴 Смена завершена!\n\n🕐 Начало: <b>${shift.start_time}</b>\n🕐 Конец: <b>${endTime}</b> (МСК)\n\n📊 <b>Статистика смены:</b>\n⭐ Квал лидов: <b>${qualLeads}</b>\n\nСпасибо за работу! 👏\n\n🕐 Во сколько планируете выйти завтра? Введите время в формате <b>ЧЧ:ММ</b> (например, <code>09:00</code>)`
      );
      user.state = "awaiting_plan_time";
      await setUser(chatId, user);
      await notifyAdmin(
        `🔴 <b>${user.name}</b> завершил смену\n🕐 Начало: ${shift.start_time}\n🕐 Конец: ${endTime} (МСК)\n\n📊 Квал лидов за смену: <b>${qualLeads}</b>`
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
      const shift = await getShift(chatId);
      if (!shift || !shift.active) {
        await sendMessage(chatId, "⚠️ Вы сейчас не на смене.", getMenu(chatId, false));
        return;
      }
      await incrementQualLeads(chatId);
      const newCount = (shift.qual_leads || 0) + 1;
      await sendMessage(
        chatId,
        `✅ Квал лид засчитан! (всего за смену: <b>${newCount}</b>)`,
        getMenu(chatId, true)
      );
      await notifyAdmin(
        `⭐⭐⭐ <b>КВАЛ ЛИД</b>\n\nОт сотрудника: <b>${user.name}</b>\n🕐 ${mskNow()} (МСК)\n📊 Всего за смену: ${newCount}`
      );
      return;
    }

    case "📨 Запросить 100 лидов": {
      const shift = await getShift(chatId);
      if (!shift || !shift.active) {
        await sendMessage(chatId, "⚠️ Вы сейчас не на смене.", getMenu(chatId, false));
        return;
      }
      await sendMessage(
        chatId,
        "✅ Запрос на 100 лидов отправлен руководителю!",
        getMenu(chatId, true)
      );
      await notifyAdmin(
        `📨 <b>ЗАПРОС 100 ЛИДОВ</b>\n\nОт сотрудника: <b>${user.name}</b>\n🕐 ${mskNow()} (МСК)`
      );
      return;
    }

    // --- Админ: статистика ---
    case "📊 Статистика за сегодня": {
      if (!checkAdmin(chatId)) break;
      const statsText = await formatStats(todayStartMs(), "за сегодня");
      const shift = await getShift(chatId);
      await sendMessage(chatId, statsText, getMenu(chatId, shift && shift.active));
      return;
    }

    case "📊 Статистика за неделю": {
      if (!checkAdmin(chatId)) break;
      const statsText = await formatStats(weekStartMs(), "за неделю");
      const shift = await getShift(chatId);
      await sendMessage(chatId, statsText, getMenu(chatId, shift && shift.active));
      return;
    }

    case "❌ Отмена": {
      user.state = "authorized";
      await setUser(chatId, user);
      await sendMessage(chatId, "↩️ Действие отменено.", getMenu(chatId, false));
      return;
    }

    default: {
      const shift = await getShift(chatId);
      await sendMessage(chatId, "Используйте кнопки меню 👇", getMenu(chatId, shift && shift.active));
    }
  }
}

// --- Проверка и отправка напоминаний (при каждом запросе) ---
async function checkReminders() {
  try {
    const now = Date.now();
    const windowEnd = now + 20 * 60 * 1000;

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

  if (!tablesReady) {
    await initTables();
    tablesReady = true;
  }

  const update = req.body;
  const message = update && update.message;

  await checkReminders();

  if (!message || !message.text) {
    return res.status(200).json({ ok: true });
  }

  const chatId = message.chat.id;
  const text = message.text.trim();

  try {
    if (text === "/start" || text === "/menu") {
      const existingUser = await getUser(chatId);
      if (existingUser && existingUser.name) {
        // Уже авторизован — просто обновить меню
        existingUser.state = "authorized";
        await setUser(chatId, existingUser);
        const shift = await getShift(chatId);
        await sendMessage(
          chatId,
          `👋 С возвращением, <b>${existingUser.name}</b>!`,
          getMenu(chatId, shift && shift.active)
        );
      } else {
        await handleStart(chatId);
      }
      return res.status(200).json({ ok: true });
    }

    const user = await getUser(chatId);

    if (!user) {
      await sendMessage(chatId, "👋 Нажмите /start для начала работы.");
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
