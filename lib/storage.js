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
      state TEXT DEFAULT 'awaiting_name',
      support_category TEXT
    )
  `;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS support_category TEXT`;
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
  await sql`ALTER TABLE shifts ADD COLUMN IF NOT EXISTS on_break BOOLEAN DEFAULT false`;
  await sql`ALTER TABLE shifts ADD COLUMN IF NOT EXISTS break_start_ts BIGINT DEFAULT 0`;
  await sql`ALTER TABLE shifts ADD COLUMN IF NOT EXISTS total_break_ms BIGINT DEFAULT 0`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS support_category TEXT`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS dm_target_id TEXT`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS dm_target_name TEXT`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_day INT`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_month INT`;
  await sql`
    CREATE TABLE IF NOT EXISTS call_analyses (
      id SERIAL PRIMARY KEY,
      lead_url TEXT,
      manager_name TEXT,
      transcription JSONB,
      score JSONB,
      created_at BIGINT
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
    INSERT INTO users (chat_id, name, state, support_category, dm_target_id, dm_target_name, plan_day, plan_month)
    VALUES (${chatId}, ${data.name || null}, ${data.state || "awaiting_name"}, ${data.support_category || null}, ${data.dm_target_id || null}, ${data.dm_target_name || null}, ${data.plan_day || null}, ${data.plan_month || null})
    ON CONFLICT (chat_id) DO UPDATE SET
      name = ${data.name || null},
      state = ${data.state || "awaiting_name"},
      support_category = ${data.support_category || null},
      dm_target_id = ${data.dm_target_id || null},
      dm_target_name = ${data.dm_target_name || null},
      plan_day = ${data.plan_day || null},
      plan_month = ${data.plan_month || null}
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

async function startBreak(chatId) {
  const sql = getDb();
  await sql`UPDATE shifts SET on_break = true, break_start_ts = ${Date.now()} WHERE chat_id = ${chatId}`;
}

async function endBreak(chatId) {
  const sql = getDb();
  const rows = await sql`SELECT break_start_ts FROM shifts WHERE chat_id = ${chatId}`;
  if (!rows.length) return 0;
  const elapsed = Date.now() - Number(rows[0].break_start_ts || 0);
  await sql`UPDATE shifts SET on_break = false, break_start_ts = 0, total_break_ms = total_break_ms + ${elapsed} WHERE chat_id = ${chatId}`;
  return elapsed;
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

async function getAllUsers() {
  const sql = getDb();
  const rows = await sql`SELECT chat_id, name, state FROM users WHERE name IS NOT NULL ORDER BY name`;
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

async function getAllPlannedShifts(fromMs) {
  const sql = getDb();
  const rows = await sql`
    SELECT * FROM planned_shifts
    WHERE planned_at >= ${fromMs}
    ORDER BY planned_at ASC
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

async function deleteUser(chatId) {
  const sql = getDb();
  await sql`DELETE FROM shifts WHERE chat_id = ${chatId}`;
  await sql`DELETE FROM planned_shifts WHERE chat_id = ${chatId}`;
  await sql`DELETE FROM users WHERE chat_id = ${chatId}`;
}

async function saveAnalysis(leadUrl, managerName, transcription, score) {
  const sql = getDb();
  const rows = await sql`
    INSERT INTO call_analyses (lead_url, manager_name, transcription, score, created_at)
    VALUES (${leadUrl}, ${managerName}, ${JSON.stringify(transcription)}, ${score ? JSON.stringify(score) : null}, ${Date.now()})
    RETURNING id
  `;
  return rows[0].id;
}

async function updateAnalysisScore(id, score) {
  const sql = getDb();
  await sql`UPDATE call_analyses SET score = ${JSON.stringify(score)} WHERE id = ${id}`;
}

async function getAnalysis(id) {
  const sql = getDb();
  const rows = await sql`SELECT * FROM call_analyses WHERE id = ${id}`;
  return rows[0] || null;
}

module.exports = {
  initTables,
  getUser,
  setUser,
  deleteUser,
  getAllUsers,
  getShift,
  setShift,
  deleteShift,
  startBreak,
  endBreak,
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
  saveAnalysis,
  updateAnalysisScore,
  getAnalysis,
};
