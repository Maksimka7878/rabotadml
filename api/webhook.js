const { sendMessage, notifyAdmin, answerCallback, editMessageReplyMarkup, editMessageText, mainMenu, onShiftMenu, supportMenu, adminMenu } = require("../lib/telegram");
const { analyzeBuffer, formatTgReply, formatNotePlain } = require("../lib/transcribe");
const { getRecordingUrl, getRecordingUrlFromLink, addNoteToLead } = require("../lib/amo");
const {
  initTables,
  getUser,
  setUser,
  getAllUsers,
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
  getAllPlannedShifts,
  removePlannedShift,
  deleteUser,
} = require("../lib/storage");

const QUAL_LEAD_PRICE = 400;
const PHONE_RE = /[+7|8][\s\-]?\(?\d{3}\)?[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}/;

function extractPhone(text) {
  const match = PHONE_RE.exec(text || "");
  return match ? match[0] : null;
}

async function downloadMp3(url) {
  const headers = {};
  if (process.env.AMO_TOKEN) headers["Authorization"] = `Bearer ${process.env.AMO_TOKEN}`;

  if (process.env.HTTPS_PROXY && url.includes("comagic.ru")) {
    const https = require("https");
    const { HttpsProxyAgent } = require("https-proxy-agent");
    const agent = new HttpsProxyAgent(process.env.HTTPS_PROXY);
    return new Promise((resolve, reject) => {
      const req = https.get(url, { agent, headers }, (res) => {
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.setTimeout(30000, () => { req.destroy(); reject(new Error("Download timeout")); });
    });
  }

  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function handleScore(chatId, cmdText, message) {
  const parts = cmdText.split(/\s+/);
  let phone = parts.length > 1 ? parts.slice(1).join(" ") : null;

  if (!phone && message.reply_to_message) {
    phone = extractPhone(message.reply_to_message.text || "");
  }

  if (!phone) {
    await sendMessage(chatId,
      "Укажи телефон:\n• <code>/score +79991234567</code>\n• или ответь на сообщение с номером командой /score"
    );
    return;
  }

  const statusResult = await sendMessage(chatId, "🔄 Ищу запись звонка...");
  const statusId = statusResult.result?.message_id;
  const editStatus = t => statusId
    ? editMessageText(chatId, statusId, t)
    : sendMessage(chatId, t);

  const mp3Url = await getRecordingUrl(phone);
  if (!mp3Url) {
    await editStatus("⚠️ Запись не найдена в AmoCRM.\nНастрой AMO_DOMAIN и AMO_TOKEN в Vercel env");
    return;
  }

  await editStatus("⬇️ Скачиваю MP3...");
  let audioBuffer;
  try {
    audioBuffer = await downloadMp3(mp3Url);
  } catch (e) {
    await editStatus(`❌ Ошибка скачивания: ${e.message}`);
    return;
  }

  await editStatus("🎙 Транскрибирую разговор... (~60 сек)");
  let transcription, score;
  try {
    ({ transcription, score } = await analyzeBuffer(audioBuffer, process.env.GEMINI_API_KEY));
  } catch (e) {
    await editStatus(`❌ Ошибка анализа: ${e.message}`);
    return;
  }

  await editStatus(formatTgReply(transcription, score, null));
}

async function analyzeLeadCall(crmLink, managerName) {
  const mp3Url = await getRecordingUrlFromLink(crmLink);
  console.log("[analyze] mp3Url:", mp3Url, "link:", crmLink);
  if (!mp3Url) {
    await notifyAdmin(`⚠️ Запись звонка не найдена для лида: ${crmLink}`);
    return;
  }

  let audioBuffer;
  try {
    console.log("[analyze] downloading:", mp3Url);
    audioBuffer = await downloadMp3(mp3Url);
  } catch (e) {
    console.error("[analyze] download error:", e.message, e.cause?.message);
    await notifyAdmin(`⚠️ Не удалось скачать запись (${managerName}): ${mp3Url?.slice(0, 80)} — ${e.message} ${e.cause?.message || ""}`);
    return;
  }

  let transcription, score;
  try {
    ({ transcription, score } = await analyzeBuffer(audioBuffer, process.env.GEMINI_API_KEY));
  } catch (e) {
    await notifyAdmin(`⚠️ Ошибка анализа звонка (${managerName}): ${e.message}`);
    return;
  }

  const tgText = formatTgReply(transcription, score, managerName);
  await notifyAdmin(`🎙 ${tgText}`);

  const noteText = formatNotePlain(transcription, score, managerName);
  await addNoteToLead(crmLink, noteText);
}

const LEAD_BATCH_PRICE = 600;
const CRM_PREFIX = "https://flatcherestate.amocrm.ru/";

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

// Парсинг конкретной даты ДД.ММ с заданным временем (МСК)
function parseSpecificDateMsk(day, month, hours, minutes) {
  const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
  const nowMsk = new Date(Date.now() + MSK_OFFSET_MS);
  const year = nowMsk.getFullYear();
  const date = new Date(Date.UTC(year, month - 1, day, hours - 3, minutes, 0, 0));
  return date.getTime();
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
  await sendMessage(chatId, "👋 <b>Добро пожаловать!</b>\n\nВведите ваше имя для авторизации:");
}

// --- Ввод имени ---
async function handleNameInput(chatId, text, user) {
  user.name = text;
  user.state = "authorized";
  await setUser(chatId, user);
  await sendMessage(chatId, `✅ Вы авторизованы как <b>${text}</b>`, getMenu(chatId, false));
  await notifyAdmin(`👋 Новый сотрудник авторизован: <b>${text}</b>\n🆔 User ID: <code>${chatId}</code>`);
}

// --- Ввод времени планируемой смены ---
async function handlePlanTimeInput(chatId, text, user) {
  if (text === "❌ Отмена") {
    user.state = "authorized";
    delete user.plan_day;
    delete user.plan_month;
    await setUser(chatId, user);
    await sendMessage(chatId, "↩️ Отменено.", getMenu(chatId, false));
    return;
  }
  const match = text.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    await sendMessage(chatId, "❌ Неверный формат. Введите время в формате <b>ЧЧ:ММ</b> (например, <code>09:00</code>):");
    return;
  }
  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  if (hours > 23 || minutes > 59) {
    await sendMessage(chatId, "❌ Неверное время. Введите время в формате <b>ЧЧ:ММ</b>:");
    return;
  }
  // Разрешаем только с 08:00 до 20:00
  const totalMinutes = hours * 60 + minutes;
  if (totalMinutes < 8 * 60 || totalMinutes > 20 * 60) {
    await sendMessage(chatId, "⛔ Смену можно запланировать только с <b>08:00</b> до <b>20:00</b>.\n\nВведите другое время:");
    return;
  }

  let plannedUtcMs;
  let dateLabel;

  // Если выбрана конкретная дата — используем её, иначе завтра
  if (user.plan_day && user.plan_month) {
    plannedUtcMs = parseSpecificDateMsk(user.plan_day, user.plan_month, hours, minutes);
    dateLabel = `${String(user.plan_day).padStart(2, "0")}.${String(user.plan_month).padStart(2, "0")}`;
  } else {
    plannedUtcMs = parseTomorrowMsk(hours, minutes);
    dateLabel = "завтра";
  }

  await addPlannedShift(chatId, plannedUtcMs, user.name);
  user.state = "authorized";
  delete user.plan_day;
  delete user.plan_month;
  await setUser(chatId, user);
  const timeStr = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  await sendMessage(chatId, `✅ Смена запланирована на <b>${dateLabel}</b> в <b>${timeStr}</b> (МСК)\n\n⏰ Вам придёт напоминание за 15 минут.`, getMenu(chatId, false));
  await notifyAdmin(`📅 <b>${user.name}</b> планирует выйти на смену <b>${dateLabel}</b> в <b>${timeStr}</b> (МСК)`);
}

// --- Ввод даты для планируемой смены (ДД.ММ) ---
async function handlePlanDateInput(chatId, text, user) {
  if (text === "❌ Отмена") {
    user.state = "authorized";
    delete user.plan_day;
    delete user.plan_month;
    await setUser(chatId, user);
    await sendMessage(chatId, "↩️ Отменено.", getMenu(chatId, false));
    return;
  }
  const match = text.match(/^(\d{1,2})\.(\d{1,2})$/);
  if (!match) {
    await sendMessage(chatId, "❌ Неверный формат. Введите дату в формате <b>ДД.ММ</b> (например, <code>15.04</code>):");
    return;
  }
  const day = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  if (day < 1 || day > 31 || month < 1 || month > 12) {
    await sendMessage(chatId, "❌ Неверная дата. Введите дату в формате <b>ДД.ММ</b>:");
    return;
  }
  user.plan_day = day;
  user.plan_month = month;
  user.state = "awaiting_plan_time";
  await setUser(chatId, user);
  const dateLabel = `${String(day).padStart(2, "0")}.${String(month).padStart(2, "0")}`;
  await sendMessage(chatId, `📅 Дата выбрана: <b>${dateLabel}</b>\n\n🕐 Теперь введите время выхода в формате <b>ЧЧ:ММ</b> (например, <code>09:00</code>):`);
}

// --- Ввод ссылки на квал лида ---
async function handleQualLinkInput(chatId, text, user) {
  if (!text.startsWith(CRM_PREFIX)) {
    await sendMessage(chatId, `❌ Неверная ссылка. Отправьте корректную ссылку на лида из CRM:`, {
      reply_markup: { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "cancel_qual" }]] }
    });
    return;
  }
  await incrementQualLeads(chatId);
  const shift = await getShift(chatId);
  const newCount = shift ? (shift.qual_leads || 0) : 1;
  user.state = "authorized";
  await setUser(chatId, user);
  await sendMessage(chatId, `⭐ Квал лид засчитан! (всего за смену: <b>${newCount}</b>)`, getMenu(chatId, true));
  await notifyAdmin(`⭐⭐⭐ <b>КВАЛ ЛИД</b>\n\nОт сотрудника: <b>${user.name}</b>\n🔗 <a href="${text}">Ссылка на лида</a>\n🕐 ${mskNow()} (МСК)\n📊 Всего за смену: ${newCount}`);
  await analyzeLeadCall(text, user.name);
}

// --- Статистика за сегодня ---
async function formatStatsToday() {
  const fromMs = todayStartMs();
  const stats = await getStats(fromMs);
  const active = await getActiveShiftsWithNames();
  const details = await getDetailedShifts(fromMs);
  if (stats.length === 0 && active.length === 0) return `📊 <b>Статистика за сегодня</b>\n\nНет данных.`;
  let text = `📊 <b>Статистика за сегодня</b>\n`;
  if (active.length > 0) {
    text += `\n🟢 <b>Сейчас на смене:</b>\n`;
    for (const s of active) text += `  • ${s.name} (с ${s.start_time}, квал: ${s.qual_leads || 0})\n`;
  }
  if (details.length > 0) {
    text += `\n📋 <b>Завершённые смены:</b>\n`;
    for (const s of details) {
      const dur = Number(s.end_ts) - Number(s.start_ts);
      text += `\n  • <b>${s.user_name}</b>\n`;
      text += `    🕐 ${s.start_time} — ${s.end_time} (${formatDuration(dur)})\n`;
      text += `    ⭐ Квал: ${s.qual_leads || 0}, 📨 Партий: ${s.lead_requests || 0}\n`;
    }
  }
  return text;
}

// --- Статистика за неделю ---
async function formatStatsWeek() {
  const fromMs = weekStartMs();
  const stats = await getStats(fromMs);
  const active = await getActiveShiftsWithNames();
  if (stats.length === 0 && active.length === 0) return `📊 <b>Статистика за неделю</b>\n\nНет данных.`;
  let text = `📊 <b>Статистика за неделю</b>\n`;
  if (active.length > 0) {
    text += `\n🟢 <b>Сейчас на смене:</b>\n`;
    for (const s of active) text += `  • ${s.name} (с ${s.start_time})\n`;
  }
  if (stats.length > 0) {
    text += `\n📋 <b>Итоги по менеджерам:</b>\n`;
    let grandTotalQual = 0, grandTotalBatches = 0, grandTotalMoney = 0;
    for (const s of stats) {
      const qual = Number(s.total_qual_leads);
      const batches = Number(s.total_lead_requests);
      const workMs = Number(s.total_work_ms);
      const money = qual * QUAL_LEAD_PRICE + batches * LEAD_BATCH_PRICE;
      text += `\n👤 <b>${s.user_name}</b>\n`;
      text += `  📅 Смен: ${s.total_shifts} (${formatDuration(workMs)})\n`;
      text += `  ⭐ Квал лидов: ${qual} × ${QUAL_LEAD_PRICE}₽ = ${qual * QUAL_LEAD_PRICE}₽\n`;
      text += `  📨 Партий: ${batches} × ${LEAD_BATCH_PRICE}₽ = ${batches * LEAD_BATCH_PRICE}₽\n`;
      text += `  💰 <b>Итого: ${money}₽</b>\n`;
      grandTotalQual += qual;
      grandTotalBatches += batches;
      grandTotalMoney += money;
    }
    text += `\n━━━━━━━━━━━━━━━\n`;
    text += `💰 <b>ОБЩИЙ ИТОГ: ${grandTotalMoney}₽</b>\n`;
    text += `⭐ Квал лидов: ${grandTotalQual} | 📨 Партий: ${grandTotalBatches}`;
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
      // Inline подтверждение (только для менеджеров)
      await sendMessage(chatId, "🟢 <b>Вы готовы начать смену?</b>", {
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Подтверждаю", callback_data: "confirm_shift_start" }],
            [{ text: "❌ Отмена", callback_data: "cancel_shift_start" }],
          ]
        }
      });
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
      await sendMessage(chatId,
        `🔴 <b>Смена завершена!</b>\n\n🕐 Начало: <b>${shift.start_time}</b>\n🕐 Конец: <b>${endTime}</b> (МСК)\n⏱ Длительность: <b>${formatDuration(duration)}</b>\n\n📊 <b>Статистика смены:</b>\n⭐ Квал лидов: <b>${qualLeads}</b>\n📨 Партий: <b>${leadRequests}</b>\n\nСпасибо за работу! 👏\n\n🕐 Во сколько планируете выйти <b>завтра</b>? Введите время в формате <b>ЧЧ:ММ</b> (например, <code>09:00</code>)`,
        { 
          reply_markup: { 
            inline_keyboard: [
              [{ text: "📅 Сменить день выхода", callback_data: "change_plan_day" }],
              [{ text: "❌ Отмена", callback_data: "cancel_plan" }]
            ]
          } 
        }
      );
      user.state = "awaiting_plan_time";
      await setUser(chatId, user);
      await notifyAdmin(`🔴 <b>${user.name}</b> завершил смену\n🕐 ${shift.start_time} — ${endTime} (${formatDuration(duration)})\n⭐ Квал: ${qualLeads} | 📨 Партий: ${leadRequests}`);
      return;
    }

    case "📅 Запланировать смену": {
      user.state = "awaiting_plan_time";
      await setUser(chatId, user);
      await sendMessage(chatId, "🕐 Введите время выхода на <b>завтрашнюю</b> смену в формате <b>ЧЧ:ММ</b> (например, <code>09:00</code>):", {
        reply_markup: { 
          inline_keyboard: [
            [{ text: "📅 Сменить день выхода", callback_data: "change_plan_day" }],
            [{ text: "❌ Отмена", callback_data: "cancel_plan" }]
          ]
        }
      });
      return;
    }

    case "⭐ Квал лид": {
      const shift = await getShift(chatId);
      if (!shift || !shift.active) {
        await sendMessage(chatId, "⚠️ Вы сейчас не на смене.", getMenu(chatId, false));
        return;
      }
      user.state = "awaiting_qual_link";
      await setUser(chatId, user);
      await sendMessage(chatId, "🔗 Отправьте ссылку на лида из CRM:", {
        reply_markup: { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "cancel_qual" }]] }
      });
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
      await sendMessage(chatId, `✅ Запрос на партию лидов отправлен! (партий за смену: <b>${newCount}</b>)`, getMenu(chatId, true));
      await sendMessage(process.env.ADMIN_CHAT_ID,
        `🔥 <b>ЗАПРОС 100 ЛИДОВ</b> (партия #${newCount})\n\nОт сотрудника: <b>${user.name}</b>\n🕐 ${mskNow()} (МСК)`,
        { reply_markup: { inline_keyboard: [[{ text: "✅ Отправить лиды", callback_data: `send_leads_${chatId}` }]] } }
      );
      return;
    }

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

    case "📅 Запланированные смены": {
      if (!checkAdmin(chatId)) break;
      const now = Date.now();
      const shifts = await getAllPlannedShifts(now);
      if (shifts.length === 0) {
        await sendMessage(chatId, "📅 <b>Запланированные смены</b>\n\nНет запланированных смен на будущее.", adminMenu());
        return;
      }
      let text = `📅 <b>Запланированные смены</b>\n`;
      // Группируем по дням
      const grouped = {};
      for (const s of shifts) {
        const d = new Date(s.timestamp);
        const dayStr = d.toLocaleString("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit" });
        const timeStr = d.toLocaleString("ru-RU", { timeZone: "Europe/Moscow", hour: "2-digit", minute: "2-digit" });
        if (!grouped[dayStr]) grouped[dayStr] = [];
        grouped[dayStr].push(`  • ${s.userName} в ${timeStr}`);
      }
      for (const day in grouped) {
        text += `\n🗓 <b>${day}</b>\n${grouped[day].join("\n")}\n`;
      }
      await sendMessage(chatId, text, adminMenu());
      return;
    }

    case "💬 Написать менеджеру": {
      if (!checkAdmin(chatId)) break;
      const allUsers = await getAllUsers();
      const managers = allUsers.filter(u => String(u.chat_id) !== String(chatId) && u.name);
      if (managers.length === 0) {
        await sendMessage(chatId, "👥 Нет зарегистрированных менеджеров.", adminMenu());
        return;
      }
      const buttons = managers.map(u => [{ text: `👤 ${u.name}`, callback_data: `dm_select_${u.chat_id}` }]);
      await sendMessage(chatId, "👥 <b>Выберите менеджера для отправки личного сообщения:</b>", {
        reply_markup: { inline_keyboard: buttons }
      });
      return;
    }

    case "🗑 Удалить менеджера": {
      if (!checkAdmin(chatId)) break;
      const allUsers = await getAllUsers();
      const managers = allUsers.filter(u => String(u.chat_id) !== String(chatId) && u.name);
      if (managers.length === 0) {
        await sendMessage(chatId, "👥 Нет зарегистрированных менеджеров.", adminMenu());
        return;
      }
      const buttons = managers.map(u => [{ text: `🗑 ${u.name}`, callback_data: `delete_select_${u.chat_id}` }]);
      buttons.push([{ text: "❌ Отмена", callback_data: "delete_cancel" }]);
      await sendMessage(chatId, "🗑 <b>Выберите менеджера для удаления:</b>", {
        reply_markup: { inline_keyboard: buttons }
      });
      return;
    }

    case "🛠 Поддержка": {
      await sendMessage(chatId, "🛠 <b>Поддержка</b>\n\nВыберите тип проблемы:", supportMenu());
      return;
    }

    case "📞 Проблема с телефонией":
    case "💻 Проблемы с CRM":
    case "❓ Другой вариант": {
      user.state = "awaiting_support_text";
      user.support_category = text;
      await setUser(chatId, user);
      await sendMessage(chatId, "✏️ Опишите вашу проблему:");
      return;
    }

    case "❌ Отмена": {
      user.state = "authorized";
      await setUser(chatId, user);
      const shift = await getShift(chatId);
      await sendMessage(chatId, "↩️ Действие отменено.", getMenu(chatId, shift && shift.active));
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
      const timeStr = shiftDate.toLocaleString("ru-RU", { timeZone: "Europe/Moscow", hour: "2-digit", minute: "2-digit" });
      await sendMessage(shift.chatId, `⏰ <b>Напоминание!</b>\n\nВаша смена начинается в <b>${timeStr}</b> (МСК)\nОсталось ~15 минут. Готовьтесь! 🔥`);
      await notifyAdmin(`⏰ Напоминание отправлено <b>${shift.userName}</b> — смена в <b>${timeStr}</b> (МСК)`);
      await removePlannedShift(shift);
    }
  } catch (err) {
    console.error("Reminder check error:", err);
  }
}

// --- Vercel handler ---
async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).json({ ok: true, info: "Bot is running" });
  }

  if (!tablesReady) {
    await initTables();
    tablesReady = true;
  }

  const update = req.body;

  // --- Обработка inline-кнопок (callback_query) ---
  if (update.callback_query) {
    const cb = update.callback_query;
    const data = cb.data;
    const cbChatId = cb.message.chat.id;

    try {
      // Подтверждение начала смены
      if (data === "confirm_shift_start") {
        const user = await getUser(cbChatId);
        const existing = await getShift(cbChatId);
        if (existing && existing.active) {
          await answerCallback(cb.id, "⚠️ Вы уже на смене!");
          await editMessageReplyMarkup(cbChatId, cb.message.message_id);
          return res.status(200).json({ ok: true });
        }
        const startTime = mskNow();
        const startTs = Date.now();
        await setShift(cbChatId, { active: true, startTime, startTs, qualLeads: 0, leadRequests: 0 });
        await editMessageReplyMarkup(cbChatId, cb.message.message_id);
        await sendMessage(cbChatId, `🟢 <b>Смена начата!</b>\n\n🕐 <b>${startTime}</b> (МСК)\n\nХорошей работы! 🔥`, getMenu(cbChatId, true));
        await notifyAdmin(`🟢 <b>${user.name}</b> вышел на смену\n🕐 ${startTime} (МСК)`);
        await answerCallback(cb.id, "✅ Смена начата!");
        return res.status(200).json({ ok: true });
      }

      // Отмена начала смены
      if (data === "cancel_shift_start") {
        await editMessageReplyMarkup(cbChatId, cb.message.message_id);
        await sendMessage(cbChatId, "↩️ Выход на смену отменён.", getMenu(cbChatId, false));
        await answerCallback(cb.id, "Отменено");
        return res.status(200).json({ ok: true });
      }

      // Отмена квал лида
      if (data === "cancel_qual") {
        const user = await getUser(cbChatId);
        if (user) {
          user.state = "authorized";
          await setUser(cbChatId, user);
        }
        await editMessageReplyMarkup(cbChatId, cb.message.message_id);
        await sendMessage(cbChatId, "↩️ Квал лид отменён.", getMenu(cbChatId, true));
        await answerCallback(cb.id, "Отменено");
        return res.status(200).json({ ok: true });
      }

      // Отправить лиды менеджеру
      if (data && data.startsWith("send_leads_")) {
        const targetChatId = data.replace("send_leads_", "");
        const targetUser = await getUser(targetChatId);
        const targetName = targetUser ? targetUser.name : "Сотрудник";
        await sendMessage(targetChatId, `📦 <b>Вам пришла новая партия лидов!</b>\n\nХорошей работы! 🔥`);
        await editMessageReplyMarkup(cbChatId, cb.message.message_id);
        await answerCallback(cb.id, `✅ Лиды отправлены ${targetName}`);
        return res.status(200).json({ ok: true });
      }

      // Проблема решена
      if (data && data.startsWith("support_resolved_")) {
        const targetChatId = data.replace("support_resolved_", "");
        const targetUser = await getUser(targetChatId);
        const targetName = targetUser ? targetUser.name : "Сотрудник";
        await sendMessage(targetChatId, `✅ <b>Ваша проблема решена!</b>\n\nЕсли что-то ещё — обращайтесь через кнопку «🛠 Поддержка».`);
        await editMessageReplyMarkup(cbChatId, cb.message.message_id);
        await answerCallback(cb.id, `✅ ${targetName} уведомлён`);
        return res.status(200).json({ ok: true });
      }

      // Выбор менеджера для личного сообщения (только для администратора)
      if (data && data.startsWith("dm_select_") && checkAdmin(cbChatId)) {
        const targetChatId = data.replace("dm_select_", "");
        const targetUser = await getUser(targetChatId);
        const targetName = targetUser ? targetUser.name : "Менеджер";
        const admin = await getUser(cbChatId);
        admin.state = "awaiting_dm_text";
        admin.dm_target_id = targetChatId;
        admin.dm_target_name = targetName;
        await setUser(cbChatId, admin);
        await editMessageReplyMarkup(cbChatId, cb.message.message_id);
        await sendMessage(cbChatId, `✏️ Введите сообщение для <b>${targetName}</b>:\n\n<i>(отправьте текст — он придёт менеджеру лично)</i>`, {
          reply_markup: { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "dm_cancel" }]] }
        });
        await answerCallback(cb.id, `Выбран: ${targetName}`);
        return res.status(200).json({ ok: true });
      }

      // Выбор менеджера для удаления
      if (data && data.startsWith("delete_select_") && checkAdmin(cbChatId)) {
        const targetChatId = data.replace("delete_select_", "");
        const targetUser = await getUser(targetChatId);
        const targetName = targetUser ? targetUser.name : "Менеджер";
        await deleteUser(targetChatId);
        await editMessageReplyMarkup(cbChatId, cb.message.message_id);
        await sendMessage(cbChatId, `✅ Менеджер <b>${targetName}</b> удалён.`, adminMenu());
        await answerCallback(cb.id, `Удалён: ${targetName}`);
        return res.status(200).json({ ok: true });
      }

      // Отмена удаления менеджера
      if (data === "delete_cancel" && checkAdmin(cbChatId)) {
        await editMessageReplyMarkup(cbChatId, cb.message.message_id);
        await sendMessage(cbChatId, "↩️ Удаление отменено.", adminMenu());
        await answerCallback(cb.id, "Отменено");
        return res.status(200).json({ ok: true });
      }

      // Отмена отправки личного сообщения
      if (data === "dm_cancel" && checkAdmin(cbChatId)) {
        const admin = await getUser(cbChatId);
        if (admin) {
          admin.state = "authorized";
          delete admin.dm_target_id;
          delete admin.dm_target_name;
          await setUser(cbChatId, admin);
        }
        await editMessageReplyMarkup(cbChatId, cb.message.message_id);
        await sendMessage(cbChatId, "↩️ Отправка сообщения отменена.", adminMenu());
        await answerCallback(cb.id, "Отменено");
        return res.status(200).json({ ok: true });
      }

      // Сменить день выхода на смену
      if (data === "change_plan_day") {
        const user = await getUser(cbChatId);
        if (user) {
          user.state = "awaiting_plan_date";
          delete user.plan_day;
          delete user.plan_month;
          await setUser(cbChatId, user);
        }
        await editMessageReplyMarkup(cbChatId, cb.message.message_id);
        await sendMessage(cbChatId, "📅 Введите дату выхода в формате <b>ДД.ММ</b>\n\nНапример: <code>15.04</code>", {
          reply_markup: { inline_keyboard: [[{ text: "❌ Отмена", callback_data: "cancel_plan" }]] }
        });
        await answerCallback(cb.id, "Введите дату");
        return res.status(200).json({ ok: true });
      }

      // Отмена планирования
      if (data === "cancel_plan") {
        const user = await getUser(cbChatId);
        if (user) {
          user.state = "authorized";
          delete user.plan_day;
          delete user.plan_month;
          await setUser(cbChatId, user);
        }
        await editMessageReplyMarkup(cbChatId, cb.message.message_id);
        await sendMessage(cbChatId, "↩️ Планирование смены отменено.", getMenu(cbChatId, false));
        await answerCallback(cb.id, "Отменено");
        return res.status(200).json({ ok: true });
      }
    } catch (err) {
      console.error("Callback error:", err);
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
    if (text.startsWith("/score") && checkAdmin(chatId)) {
      res.status(200).json({ ok: true });
      await handleScore(chatId, text, message);
      return;
    }

    if (text === "/start" || text === "/menu") {
      const existingUser = await getUser(chatId);
      if (existingUser && existingUser.name) {
        existingUser.state = "authorized";
        await setUser(chatId, existingUser);
        const shift = await getShift(chatId);
        await sendMessage(chatId, `👋 С возвращением, <b>${existingUser.name}</b>!`, getMenu(chatId, shift && shift.active));
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

    if (user.state === "awaiting_qual_link") {
      await handleQualLinkInput(chatId, text, user);
      return res.status(200).json({ ok: true });
    }

    if (user.state === "awaiting_name") {
      await handleNameInput(chatId, text, user);
    } else if (user.state === "awaiting_plan_date") {
      await handlePlanDateInput(chatId, text, user);
    } else if (user.state === "awaiting_plan_time") {
      await handlePlanTimeInput(chatId, text, user);
    } else if (user.state === "awaiting_dm_text" && checkAdmin(chatId)) {
      // Отправка личного сообщения менеджеру от администратора
      const targetId = user.dm_target_id;
      const targetName = user.dm_target_name || "Менеджер";
      user.state = "authorized";
      delete user.dm_target_id;
      delete user.dm_target_name;
      await setUser(chatId, user);
      await sendMessage(targetId, `📩 <b>Сообщение от администратора:</b>\n\n${text}`);
      await sendMessage(chatId, `✅ Сообщение отправлено менеджеру <b>${targetName}</b>!`, adminMenu());
    } else if (user.state === "awaiting_support_text") {
      const category = user.support_category || "Не указана";
      user.state = "authorized";
      user.support_category = null;
      await setUser(chatId, user);
      const shift = await getShift(chatId);
      await sendMessage(chatId, `✅ <b>Ваша проблема отправлена в тех. поддержку!</b>\n\nВам придёт сообщение, когда проблема будет решена.`, getMenu(chatId, shift && shift.active));
      await sendMessage(process.env.ADMIN_CHAT_ID,
        `🛠 <b>ЗАПРОС В ПОДДЕРЖКУ</b>\n\n👤 От: <b>${user.name}</b>\n📂 Категория: <b>${category}</b>\n💬 Описание: ${text}\n🕐 ${mskNow()} (МСК)`,
        { reply_markup: { inline_keyboard: [[{ text: "✅ Проблема решена", callback_data: `support_resolved_${chatId}` }]] } }
      );
    } else {
      await handleMenuButton(chatId, text, user);
    }
  } catch (err) {
    console.error("Webhook error:", err);
    await sendMessage(chatId, "❌ Произошла ошибка. Попробуйте позже.").catch(() => {});
  }

  return res.status(200).json({ ok: true });
}

module.exports = handler;
module.exports.config = { maxDuration: 60 };
