const { Redis } = require("@upstash/redis");

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// --- Пользователи ---

async function getUser(chatId) {
  return redis.get(`user:${chatId}`);
}

async function setUser(chatId, data) {
  return redis.set(`user:${chatId}`, data);
}

// --- Активные смены ---

async function getShift(chatId) {
  return redis.get(`shift:${chatId}`);
}

async function setShift(chatId, data) {
  return redis.set(`shift:${chatId}`, data);
}

async function deleteShift(chatId) {
  return redis.del(`shift:${chatId}`);
}

// --- Запланированные смены ---

async function addPlannedShift(chatId, timestampMs, userName) {
  const member = JSON.stringify({ chatId, userName, timestamp: timestampMs });
  await redis.zadd("planned_shifts", { score: timestampMs, member });
}

async function getUpcomingShifts(fromMs, toMs) {
  const raw = await redis.zrangebyscore("planned_shifts", fromMs, toMs);
  return raw.map((s) => (typeof s === "string" ? JSON.parse(s) : s));
}

async function removePlannedShift(shiftObj) {
  const member =
    typeof shiftObj === "string" ? shiftObj : JSON.stringify(shiftObj);
  await redis.zrem("planned_shifts", member);
}

module.exports = {
  redis,
  getUser,
  setUser,
  getShift,
  setShift,
  deleteShift,
  addPlannedShift,
  getUpcomingShifts,
  removePlannedShift,
};
