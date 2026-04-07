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

async function notifyAdmin(text) {
  return sendMessage(ADMIN_CHAT_ID, text);
}

function mainMenu() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "🟢 Выйти на смену" }],
        [{ text: "📅 Запланировать смену" }],
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
        [{ text: "🔴 Завершить смену" }],
      ],
      resize_keyboard: true,
    },
  };
}

function adminMenu() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "📊 Статистика за сегодня" }],
        [{ text: "📊 Статистика за неделю" }],
      ],
      resize_keyboard: true,
    },
  };
}

function isAdmin(chatId) {
  return String(chatId) === String(process.env.ADMIN_CHAT_ID);
}

module.exports = { sendMessage, notifyAdmin, mainMenu, onShiftMenu, adminMenu, isAdmin, API_BASE };
