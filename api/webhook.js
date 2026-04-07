const { sendMessage, notifyAdmin, answerCallback, editMessageReplyMarkup, mainMenu, onShiftMenu, adminMenu } = require("../lib/telegram");
const {
  initTables,
  getUser,
  setUser,
  getShift,
  setShift,
  deleteShift,
  incrementQualLeads,
  incrementLeadRequests,
  logShift,
  getStats,
  getDetailedShifts,
  getActiveShiftsWithNames,
  addPlannedShift,
  getUpcomingShifts,
  removePlannedShift,
} = require("../lib/storage");

const QUAL_LEAD_PRICE = 400;
const LEAD_BATCH_PRICE = 600;

// Premium emoji (tg-emoji)
const E = {
  hi:    '<tg-emoji emoji-id="5368324170671202286">👋</tg-emoji>',
  fire:  '<tg-emoji emoji-id="5447644880824181073">🔥</tg-emoji>',
  check: '<tg-emoji emoji-id="5447183459602669338">✅</tg-emoji>',
  star:  '<tg-emoji emoji-id="5440539497383087970">⭐</tg-emoji>',
  clock: '<tg-emoji emoji-id="5447410659077661506">🕐</tg-emoji>',
  warn:  '<tg-emoji emoji-id="5447588922505766498">⚠️</tg-emoji>',
  red:   '<tg-emoji emoji-id="5447002378662232950">🔴</tg-emoji>',
  green: '<tg-emoji emoji-id="5447137669928940929">🟢</tg-emoji>',
  money: '<tg-emoji emoji-id="5443038326535759644">💰</tg-emoji>',
  chart: '<tg-emoji emoji-id="5447410659077661506">📊</tg-emoji>',
  pack:  '<tg-emoji emoji-id="5449683594425410616">📦</tg-emoji>',
  bell:  '<tg-emoji emoji-id="5447410659077661506">⏰</tg-emoji>',
  flex:  '<tg-emoji emoji-id="5447644880824181073">💪</tg-emoji>',
  clap:  '<tg-emoji emoji-id="5443038326535759644">👏</tg-emoji>',
};

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

function todayStartMs() {
  const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
  const nowMsk = new Date(Date.now() + MSK_OFFSET_MS);
  const start = new Date(nowMsk);
  start.setHours(0, 0, 0, 0);
  return start.getTime() - MSK_OFFSET_MS;
}

function weekStartMs() {
  const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
  const nowMsk = new Date(Date.now() + MSK_OFFSET_MS);
  const day = nowMsk.getDay();
  const diff = day === 0 ? 6 : day - 1;
  const start = new Date(nowMsk);
  start.setDate(start.getDate() - diff);
  start.setHours(0, 0, 0, 0);
  return start.getTime() - MSK_OFFSET_MS;
}

function formatDuration(ms) {
  if (!ms || ms <= 0) return "0ч 0м";
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  return `${hours}ч ${minutes}м`;
}

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
    `${E.hi} <b>Добро пожаловать!</b>\n\nВведите ваше имя для авторизации:`
  );
}

// --- Ввод имени ---
async function handleNameInput(chatId, text, user) {
  user.name = text;
  user.state = "authorized";
  await setUser(chatId, user);
  await sendMessage(
    chatId,
    `${E.check} Вы авторизованы как <b>${text}</b>`,
    getMenu(chatId, false)
  );
  await notifyAdmin(`${E.hi} Новый сотрудник авторизован: <b>${text}</b>`);
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
    `${E.check} Смена запланирована на завтра в <b>${timeStr}</b> (МСК)\n\n${E.bell} Вам придёт напоминание за 15 минут.`,
    getMenu(chatId, false)
  );
  await notifyAdmin(
    `📅 <b>${user.name}</b> планирует выйти на смену завтра в <b>${timeStr}</b> (МСК)`
  );
}

// --- Статистика за сегодня ---
async function formatStatsToday() {
  const fromMs = todayStartMs();
  const stats = await getStats(fromMs);
  const active = await getActiveShiftsWithNames();
  const details = await getDetailedShifts(fromMs);

  if (stats.length === 0 && active.length === 0) {
    return `${E.chart} <b>Статистика за сегодня</b>\n\nНет данных.`;
  }

  let text = `${E.chart} <b>Статистика за сегодня</b>\n`;

  if (active.length > 0) {
    text += `\n${E.green} <b>Сейчас на смене:</b>\n`;
    for (const s of active) {
      text += `  • ${s.name} (с ${s.start_time}, квал: ${s.qual_leads || 0})\n`;
    }
  }

  if (details.length > 0) {
    text += `\n📋 <b>Завершённые смены:</b>\n`;
    for (const s of details) {
      const dur = Number(s.end_ts) - Number(s.start_ts);
      text += `\n  • <b>${s.user_name}</b>\n`;
      text += `    ${E.clock} ${s.start_time} — ${s.end_time} (${formatDuration(dur)})\n`;
      text += `    ${E.star} Квал: ${s.qual_leads || 0}, 📨 Партий: ${s.lead_requests || 0}\n`;
    }
  }

  return text;
}

// --- Статистика за неделю (с расчётом ЗП) ---
async function formatStatsWeek() {
  const fromMs = weekStartMs();
  const stats = await getStats(fromMs);
  const active = await getActiveShiftsWithNames();

  if (stats.length === 0 && active.length === 0) {
    return `${E.chart} <b>Статистика за неделю</b>\n\nНет данных.`;
  }

  let text = `${E.chart} <b>Статистика за неделю</b>\n`;

  if (active.length > 0) {
    text += `\n${E.green} <b>Сейчас на смене:</b>\n`;
    for (const s of active) {
      text += `  • ${s.name} (с ${s.start_time})\n`;
    }
  }

  if (stats.length > 0) {
    text += `\n📋 <b>Итоги по менеджерам:</b>\n`;
    let grandTotalQual = 0;
    let grandTotalBatches = 0;
    let grandTotalMoney = 0;

    for (const s of stats) {
      const qual = Number(s.total_qual_leads);
      const batches = Number(s.total_lead_requests);
      const workMs = Number(s.total_work_ms);
      const money = qual * QUAL_LEAD_PRICE + batches * LEAD_BATCH_PRICE;

      text += `\n👤 <b>${s.user_name}</b>\n`;
      text += `  📅 Смен: ${s.total_shifts} (${formatDuration(workMs)})\n`;
      text += `  ${E.star} Квал лидов: ${qual} × ${QUAL_LEAD_PRICE}₽ = ${qual * QUAL_LEAD_PRICE}₽\n`;
      text += `  📨 Партий: ${batches} × ${LEAD_BATCH_PRICE}₽ = ${batches * LEAD_BATCH_PRICE}₽\n`;
      text += `  ${E.money} <b>Итого: ${money}₽</b>\n`;

      grandTotalQual += qual;
      grandTotalBatches += batches;
      grandTotalMoney += money;
    }

    text += `\n━━━━━━━━━━━━━━━\n`;
    text += `${E.money} <b>ОБЩИЙ ИТОГ: ${grandTotalMoney}₽</b>\n`;
    text += `${E.star} Квал лидов: ${grandTotalQual} | 📨 Партий: ${grandTotalBatches}`;
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
      const startTs = Date.now();
      await setShift(chatId, { active: true, startTime, startTs, qualLeads: 0, leadRequests: 0 });
      await sendMessage(
        chatId,
        `${E.green} <b>Смена начата!</b>\n\n${E.clock} <b>${startTime}</b> (МСК)\n\nХорошей работы! ${E.fire}`,
        getMenu(chatId, true)
      );
      await notifyAdmin(
        `${E.green} <b>${user.name}</b> вышел на смену\n${E.clock} ${startTime} (МСК)`
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
      const endTs = Date.now();
      const qualLeads = shift.qual_leads || 0;
      const leadRequests = shift.lead_requests || 0;
      const startTs = Number(shift.start_ts) || 0;
      const duration = endTs - startTs;

      await logShift(chatId, user.name, shift.start_time, endTime, startTs, endTs, qualLeads, leadRequests);
      await deleteShift(chatId);
      await sendMessage(
        chatId,
        `${E.red} <b>Смена завершена!</b>\n\n${E.clock} Начало: <b>${shift.start_time}</b>\n${E.clock} Конец: <b>${endTime}</b> (МСК)\n⏱ Длительность: <b>${formatDuration(duration)}</b>\n\n${E.chart} <b>Статистика смены:</b>\n${E.star} Квал лидов: <b>${qualLeads}</b>\n📨 Партий: <b>${leadRequests}</b>\n\nСпасибо за работу! ${E.clap}\n\n${E.clock} Во сколько планируете выйти завтра? Введите время в формате <b>ЧЧ:ММ</b> (например, <code>09:00</code>)`
      );
      user.state = "awaiting_plan_time";
      await setUser(chatId, user);
      await notifyAdmin(
        `${E.red} <b>${user.name}</b> завершил смену\n${E.clock} ${shift.start_time} — ${endTime} (${formatDuration(duration)})\n${E.star} Квал: ${qualLeads} | 📨 Партий: ${leadRequests}`
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
        `${E.star} Квал лид засчитан! (всего за смену: <b>${newCount}</b>)`,
        getMenu(chatId, true)
      );
      await notifyAdmin(
        `${E.star}${E.star}${E.star} <b>КВАЛ ЛИД</b>\n\nОт сотрудника: <b>${user.name}</b>\n${E.clock} ${mskNow()} (МСК)\n${E.chart} Всего за смену: ${newCount}`
      );
      return;
    }

    case "📨 Запросить 100 лидов": {
      const shift = await getShift(chatId);
      if (!shift || !shift.active) {
        await sendMessage(chatId, "⚠️ Вы сейчас не на смене.", getMenu(chatId, false));
        return;
      }
      await incrementLeadRequests(chatId);
      const newCount = (shift.lead_requests || 0) + 1;
      await sendMessage(
        chatId,
        `${E.check} Запрос на партию лидов отправлен! (партий за смену: <b>${newCount}</b>)`,
        getMenu(chatId, true)
      );
      await sendMessage(process.env.ADMIN_CHAT_ID,
        `${E.fire} <b>ЗАПРОС 100 ЛИДОВ</b> (партия #${newCount})\n\nОт сотрудника: <b>${user.name}</b>\n${E.clock} ${mskNow()} (МСК)`,
        {
          reply_markup: {
            inline_keyboard: [[
              { text: "✅ Отправить лиды", callback_data: `send_leads_${chatId}` }
            ]]
          }
        }
      );
      return;
    }

    // --- Админ: статистика ---
    case "📊 Статистика за сегодня": {
      if (!checkAdmin(chatId)) break;
      const statsText = await formatStatsToday();
      await sendMessage(chatId, statsText, adminMenu());
      return;
    }

    case "📊 Статистика за неделю": {
      if (!checkAdmin(chatId)) break;
      const statsText = await formatStatsWeek();
      await sendMessage(chatId, statsText, adminMenu());
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

// --- Проверка и отправка напоминаний ---
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
        `${E.bell} <b>Напоминание!</b>\n\nВаша смена начинается в <b>${timeStr}</b> (МСК)\nОсталось ~15 минут. Готовьтесь! ${E.fire}`
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

  await checkReminders();

  // --- Обработка inline-кнопок (callback_query) ---
  if (update.callback_query) {
    const cb = update.callback_query;
    const data = cb.data;

    if (data && data.startsWith("send_leads_")) {
      const targetChatId = data.replace("send_leads_", "");
      const targetUser = await getUser(targetChatId);
      const targetName = targetUser ? targetUser.name : "Сотрудник";

      // Отправляем менеджеру уведомление
      await sendMessage(
        targetChatId,
        `${E.pack} <b>Вам пришла новая партия лидов!</b>\n\nХорошей работы! ${E.fire}`
      );

      // Убираем кнопку и отвечаем админу
      await editMessageReplyMarkup(cb.message.chat.id, cb.message.message_id);
      await answerCallback(cb.id, `✅ Лиды отправлены ${targetName}`);
    }

    return res.status(200).json({ ok: true });
  }

  const message = update && update.message;

  if (!message || !message.text) {
    return res.status(200).json({ ok: true });
  }

  const chatId = message.chat.id;
  const text = message.text.trim();

  try {
    if (text === "/start" || text === "/menu") {
      const existingUser = await getUser(chatId);
      if (existingUser && existingUser.name) {
        existingUser.state = "authorized";
        await setUser(chatId, existingUser);
        const shift = await getShift(chatId);
        await sendMessage(
          chatId,
          `${E.hi} С возвращением, <b>${existingUser.name}</b>!`,
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
