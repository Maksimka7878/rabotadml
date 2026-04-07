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
      start_ts BIGINT DEFAULT 0,
      qual_leads INT DEFAULT 0,
      lead_requests INT DEFAULT 0
    )
  `;
  await sql`ALTER TABLE shifts ADD COLUMN IF NOT EXISTS qual_leads INT DEFAULT 0`;
  await sql`ALTER TABLE shifts ADD COLUMN IF NOT EXISTS lead_requests INT DEFAULT 0`;
  await sql`ALTER TABLE shifts ADD COLUMN IF NOT EXISTS start_ts BIGINT DEFAULT 0`;
  await sql`
    CREATE TABLE IF NOT EXISTS planned_shifts (
      id SERIAL PRIMARY KEY,
      chat_id BIGINT NOT NULL,
      user_name TEXT,
      planned_at BIGINT NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS shift_log (
      id SERIAL PRIMARY KEY,
      chat_id BIGINT NOT NULL,
      user_name TEXT,
      start_time TEXT,
      end_time TEXT,
      start_ts BIGINT DEFAULT 0,
      end_ts BIGINT DEFAULT 0,
      qual_leads INT DEFAULT 0,
      lead_requests INT DEFAULT 0,
      completed_at BIGINT NOT NULL
    )
  `;
  await sql`ALTER TABLE shift_log ADD COLUMN IF NOT EXISTS start_ts BIGINT DEFAULT 0`;
  await sql`ALTER TABLE shift_log ADD COLUMN IF NOT EXISTS end_ts BIGINT DEFAULT 0`;
  await sql`ALTER TABLE shift_log ADD COLUMN IF NOT EXISTS lead_requests INT DEFAULT 0`;
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
    INSERT INTO shifts (chat_id, active, start_time, start_ts, qual_leads, lead_requests)
    VALUES (${chatId}, ${data.active}, ${data.startTime}, ${data.startTs || 0}, ${data.qualLeads || 0}, ${data.leadRequests || 0})
    ON CONFLICT (chat_id) DO UPDATE SET
      active = ${data.active},
      start_time = ${data.startTime},
      start_ts = ${data.startTs || 0},
      qual_leads = ${data.qualLeads || 0},
      lead_requests = ${data.leadRequests || 0}
  `;
}

async function incrementQualLeads(chatId) {
  const sql = getDb();
  await sql`UPDATE shifts SET qual_leads = qual_leads + 1 WHERE chat_id = ${chatId}`;
}

async function incrementLeadRequests(chatId) {
  const sql = getDb();
  await sql`UPDATE shifts SET lead_requests = lead_requests + 1 WHERE chat_id = ${chatId}`;
}

async function deleteShift(chatId) {
  const sql = getDb();
  await sql`DELETE FROM shifts WHERE chat_id = ${chatId}`;
}

// --- Лог завершённых смен ---

async function logShift(chatId, userName, startTime, endTime, startTs, endTs, qualLeads, leadRequests) {
  const sql = getDb();
  await sql`
    INSERT INTO shift_log (chat_id, user_name, start_time, end_time, start_ts, end_ts, qual_leads, lead_requests, completed_at)
    VALUES (${chatId}, ${userName}, ${startTime}, ${endTime}, ${startTs}, ${endTs}, ${qualLeads}, ${leadRequests}, ${Date.now()})
  `;
}

async function getStats(fromMs) {
  const sql = getDb();
  const rows = await sql`
    SELECT user_name,
      COUNT(*) as total_shifts,
      COALESCE(SUM(qual_leads), 0) as total_qual_leads,
      COALESCE(SUM(lead_requests), 0) as total_lead_requests,
      COALESCE(SUM(end_ts - start_ts), 0) as total_work_ms
    FROM shift_log
    WHERE completed_at >= ${fromMs}
    GROUP BY user_name
    ORDER BY total_qual_leads DESC
  `;
  return rows;
}

async function getDetailedShifts(fromMs) {
  const sql = getDb();
  const rows = await sql`
    SELECT user_name, start_time, end_time, start_ts, end_ts, qual_leads, lead_requests
    FROM shift_log
    WHERE completed_at >= ${fromMs}
    ORDER BY user_name, completed_at
  `;
  return rows;
}

async function getActiveShiftsWithNames() {
  const sql = getDb();
  const rows = await sql`
    SELECT s.chat_id, s.start_time, s.qual_leads, u.name
    FROM shifts s
    JOIN users u ON s.chat_id = u.chat_id
    WHERE s.active = true
  `;
  return rows;
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
  incrementLeadRequests,
  logShift,
  getStats,
  getDetailedShifts,
  getActiveShiftsWithNames,
  addPlannedShift,
  getUpcomingShifts,
  removePlannedShift,
};
