const { neon } = require("@neondatabase/serverless");

function getDb() {
  return neon(process.env.DATABASE_URL || process.env.STORAGE_URL);
}

// --- Инициализация таблиц ---

async function initTables() {
  const sql = getDb();
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      chat_id BIGINT PRIMARY KEY,
      name TEXT,
      state TEXT DEFAULT 'awaiting_name'
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS shifts (
      chat_id BIGINT PRIMARY KEY,
      active BOOLEAN DEFAULT true,
      start_time TEXT,
      qual_leads INT DEFAULT 0
    )
  `;
  // Добавляем колонку если таблица уже существовала без неё
  await sql`
    ALTER TABLE shifts ADD COLUMN IF NOT EXISTS qual_leads INT DEFAULT 0
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS planned_shifts (
      id SERIAL PRIMARY KEY,
      chat_id BIGINT NOT NULL,
      user_name TEXT,
      planned_at BIGINT NOT NULL
    )
  `;
}

// --- Пользователи ---

async function getUser(chatId) {
  const sql = getDb();
  const rows = await sql`SELECT * FROM users WHERE chat_id = ${chatId}`;
  return rows.length ? rows[0] : null;
}

async function setUser(chatId, data) {
  const sql = getDb();
  await sql`
    INSERT INTO users (chat_id, name, state)
    VALUES (${chatId}, ${data.name || null}, ${data.state || "awaiting_name"})
    ON CONFLICT (chat_id) DO UPDATE SET
      name = ${data.name || null},
      state = ${data.state || "awaiting_name"}
  `;
}

// --- Активные смены ---

async function getShift(chatId) {
  const sql = getDb();
  const rows = await sql`SELECT * FROM shifts WHERE chat_id = ${chatId} AND active = true`;
  return rows.length ? rows[0] : null;
}

async function setShift(chatId, data) {
  const sql = getDb();
  await sql`
    INSERT INTO shifts (chat_id, active, start_time, qual_leads)
    VALUES (${chatId}, ${data.active}, ${data.startTime}, ${data.qualLeads || 0})
    ON CONFLICT (chat_id) DO UPDATE SET
      active = ${data.active},
      start_time = ${data.startTime},
      qual_leads = ${data.qualLeads || 0}
  `;
}

async function incrementQualLeads(chatId) {
  const sql = getDb();
  await sql`UPDATE shifts SET qual_leads = qual_leads + 1 WHERE chat_id = ${chatId}`;
}

async function deleteShift(chatId) {
  const sql = getDb();
  await sql`DELETE FROM shifts WHERE chat_id = ${chatId}`;
}

// --- Запланированные смены ---

async function addPlannedShift(chatId, timestampMs, userName) {
  const sql = getDb();
  await sql`
    INSERT INTO planned_shifts (chat_id, user_name, planned_at)
    VALUES (${chatId}, ${userName}, ${timestampMs})
  `;
}

async function getUpcomingShifts(fromMs, toMs) {
  const sql = getDb();
  const rows = await sql`
    SELECT * FROM planned_shifts
    WHERE planned_at >= ${fromMs} AND planned_at <= ${toMs}
  `;
  return rows.map((r) => ({
    chatId: r.chat_id,
    userName: r.user_name,
    timestamp: Number(r.planned_at),
  }));
}

async function removePlannedShift(shiftObj) {
  const sql = getDb();
  await sql`
    DELETE FROM planned_shifts
    WHERE chat_id = ${shiftObj.chatId} AND planned_at = ${shiftObj.timestamp}
  `;
}

module.exports = {
  initTables,
  getUser,
  setUser,
  getShift,
  setShift,
  deleteShift,
  incrementQualLeads,
  addPlannedShift,
  getUpcomingShifts,
  removePlannedShift,
};
