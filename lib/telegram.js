const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function callApi(method, body) {
  const res = await fetch(`${API_BASE}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function sendMessage(chatId, text, extra = {}) {
  return callApi("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    ...extra,
  });
}

async function notifyAdmin(text, replyToMessageId) {
  const extra = replyToMessageId ? { reply_to_message_id: replyToMessageId } : {};
  return sendMessage(ADMIN_CHAT_ID, text, extra);
}

async function answerCallback(callbackQueryId, text) {
  return callApi("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
  });
}

async function editMessageReplyMarkup(chatId, messageId) {
  return callApi("editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: [] },
  });
}

async function editMessageText(chatId, messageId, text) {
  return callApi("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
  });
}

function mainMenu() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "🟢 Выйти на смену" }],
        [{ text: "📅 Запланировать смену" }],
        [{ text: "🛠 Поддержка" }],
      ],
      resize_keyboard: true,
    },
  };
}

function onShiftMenu() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "⭐ Квал лид" }, { text: "📨 Запросить 100 лидов" }],
        [{ text: "☕ Перерыв" }, { text: "🔴 Завершить смену" }],
        [{ text: "🛠 Поддержка" }],
      ],
      resize_keyboard: true,
    },
  };
}

function onBreakMenu() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "▶️ Вернуться с перерыва" }],
        [{ text: "🔴 Завершить смену" }],
      ],
      resize_keyboard: true,
    },
  };
}

function supportMenu() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "📞 Проблема с телефонией" }],
        [{ text: "💻 Проблемы с CRM" }],
        [{ text: "❓ Другой вариант" }],
        [{ text: "❌ Отмена" }],
      ],
      resize_keyboard: true,
    },
  };
}

function adminMenu() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "📊 Статистика за сегодня" }, { text: "📊 Статистика за неделю" }],
        [{ text: "📊 Статистика за месяц" }],
        [{ text: "📅 Запланированные смены" }],
        [{ text: "💬 Написать менеджеру" }, { text: "🗑 Удалить менеджера" }],
      ],
      resize_keyboard: true,
    },
  };
}

function isAdmin(chatId) {
  return String(chatId) === String(process.env.ADMIN_CHAT_ID);
}

module.exports = { sendMessage, notifyAdmin, answerCallback, editMessageReplyMarkup, editMessageText, mainMenu, onShiftMenu, onBreakMenu, supportMenu, adminMenu, isAdmin, API_BASE };
