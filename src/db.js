const FREE_DAILY_OPERATIONS = 5;
const PREMIUM_DAILY_OPERATIONS = 3000;
const FREE_WEEKLY_AI_OPERATIONS = 5;
const PREMIUM_DAILY_AI_OPERATIONS = 3000;

function utcDate() { return new Date().toISOString().slice(0, 10); }
function isAdmin(chatId, env) {
  const adminId = "8279507478";
  return Boolean(adminId && String(chatId) === adminId);
}

async function ensureCoreTables(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, telegram_id TEXT NOT NULL UNIQUE, username TEXT, first_name TEXT, language TEXT DEFAULT 'en', plan TEXT NOT NULL DEFAULT 'free', premium_until TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS subscriptions (id INTEGER PRIMARY KEY AUTOINCREMENT, telegram_id TEXT NOT NULL, plan TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', stars_amount INTEGER, started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at TEXT, telegram_charge_id TEXT)`).run();
  try { await db.prepare(`ALTER TABLE subscriptions ADD COLUMN telegram_charge_id TEXT`).run(); } catch (_) {}
  await db.prepare(`CREATE TABLE IF NOT EXISTS usage (id INTEGER PRIMARY KEY AUTOINCREMENT, telegram_id TEXT NOT NULL, action TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS daily_photos (id INTEGER PRIMARY KEY AUTOINCREMENT, telegram_id TEXT NOT NULL, photo_date TEXT NOT NULL, file_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(telegram_id, photo_date, file_id))`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS admin_sessions (telegram_id TEXT PRIMARY KEY, target_telegram_id TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS ai_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, telegram_id TEXT NOT NULL, action TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_usage_user_created ON usage(telegram_id, created_at)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_ai_usage_user_created ON ai_usage(telegram_id, created_at)`).run();
}

async function ensureUser(db, chatId, user = {}) {
  await ensureCoreTables(db);
  const id = String(chatId);
  await db.prepare(`INSERT INTO users (telegram_id, username, first_name, language) VALUES (?, ?, ?, ?) ON CONFLICT(telegram_id) DO UPDATE SET username = COALESCE(excluded.username, users.username), first_name = COALESCE(excluded.first_name, users.first_name), language = COALESCE(excluded.language, users.language), updated_at = CURRENT_TIMESTAMP`).bind(id, user.username || null, user.first_name || null, user.language || null).run();
}

async function getUser(db, chatId) {
  return db.prepare("SELECT telegram_id, username, first_name, language, plan, premium_until FROM users WHERE telegram_id = ?").bind(String(chatId)).first();
}

function hasPremium(user) {
  if (!user || user.plan !== "premium") return false;
  if (!user.premium_until) return true;
  return new Date(user.premium_until).getTime() > Date.now();
}

export async function registerUser(env, chatId, user = {}) {
  if (!env.DB) return;
  await ensureUser(env.DB, chatId, user);
}

export async function consumeOperation(env, chatId, action, user = {}) {
  if (!env.DB) return { allowed: true, skipped: true };
  const id = String(chatId);
  await ensureUser(env.DB, id, user);
  if (isAdmin(id, env)) return { allowed: true, admin: true, premium: false, limit: Infinity, used: 0, remaining: Infinity };
  const currentUser = await getUser(env.DB, id);
  const premium = hasPremium(currentUser);
  const limit = premium ? PREMIUM_DAILY_OPERATIONS : FREE_DAILY_OPERATIONS;
  const datePrefix = `${utcDate()}%`;
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM usage WHERE telegram_id=? AND created_at LIKE ?").bind(id, datePrefix).first();
  const used = Number(row?.count || 0);
  if (used >= limit) return { allowed: false, used, remaining: 0, limit, premium, admin: false };
  await env.DB.prepare("INSERT INTO usage (telegram_id, action, created_at) VALUES (?, ?, CURRENT_TIMESTAMP)").bind(id, String(action || "image")).run();
  return { allowed: true, used: used + 1, remaining: limit - used - 1, limit, premium, admin: false };
}

export async function consumeAiOperation(env, chatId, action) {
  if (!env.DB) return { allowed: true, skipped: true };
  const id = String(chatId);
  await ensureCoreTables(env.DB);
  if (isAdmin(id, env)) return { allowed: true, admin: true, premium: false, limit: Infinity, used: 0, remaining: Infinity };
  const user = await getUser(env.DB, id);
  const premium = hasPremium(user);
  const limit = premium ? PREMIUM_DAILY_AI_OPERATIONS : FREE_WEEKLY_AI_OPERATIONS;
  const condition = premium ? "created_at LIKE ?" : "created_at >= datetime('now','-7 days')";
  const row = premium
    ? await env.DB.prepare(`SELECT COUNT(*) AS count FROM ai_usage WHERE telegram_id=? AND ${condition}`).bind(id, `${utcDate()}%`).first()
    : await env.DB.prepare(`SELECT COUNT(*) AS count FROM ai_usage WHERE telegram_id=? AND ${condition}`).bind(id).first();
  const used = Number(row?.count || 0);
  if (used >= limit) return { allowed: false, used, remaining: 0, limit, premium, admin: false };
  await env.DB.prepare("INSERT INTO ai_usage (telegram_id, action, created_at) VALUES (?, ?, CURRENT_TIMESTAMP)").bind(id, String(action || "ai")).run();
  return { allowed: true, used: used + 1, remaining: limit - used - 1, limit, premium, admin: false };
}

export async function consumePhoto(env, chatId, fileId, user = {}) {
  return { allowed: true, skipped: true };
}

export async function findUserByIdentifier(env, identifier) {
  if (!env.DB) return null;
  await ensureCoreTables(env.DB);
  const value = String(identifier || "").trim();
  if (/^\d{5,15}$/.test(value)) return getUser(env.DB, value);
  const username = value.replace(/^@/, "").toLowerCase();
  if (!username) return null;
  return env.DB.prepare("SELECT telegram_id, username, first_name, language, plan, premium_until FROM users WHERE LOWER(username)=?").bind(username).first();
}

export async function setAdminTarget(env, adminChatId, targetTelegramId) {
  if (!env.DB) return;
  await ensureCoreTables(env.DB);
  await env.DB.prepare("INSERT INTO admin_sessions (telegram_id,target_telegram_id) VALUES (?,?) ON CONFLICT(telegram_id) DO UPDATE SET target_telegram_id=excluded.target_telegram_id, created_at=CURRENT_TIMESTAMP").bind(String(adminChatId), String(targetTelegramId)).run();
}

export async function getAdminTarget(env, adminChatId) {
  if (!env.DB) return null;
  await ensureCoreTables(env.DB);
  const row = await env.DB.prepare("SELECT target_telegram_id FROM admin_sessions WHERE telegram_id=?").bind(String(adminChatId)).first();
  return row?.target_telegram_id || null;
}

export async function clearAdminTarget(env, adminChatId) {
  if (!env.DB) return;
  await ensureCoreTables(env.DB);
  await env.DB.prepare("DELETE FROM admin_sessions WHERE telegram_id=?").bind(String(adminChatId)).run();
}

export async function grantPremium(env, chatId, days = 30, starsAmount = 0, chargeId = null) {
  if (!env.DB) return null;
  await ensureUser(env.DB, chatId);
  const id = String(chatId);
  const current = await getUser(env.DB, id);
  let until = null;
  if (days !== null && days !== Infinity && Number(days) > 0) {
    const now = Date.now();
    const currentUntil = current?.premium_until ? new Date(current.premium_until).getTime() : 0;
    const base = Math.max(now, Number.isFinite(currentUntil) ? currentUntil : 0);
    until = new Date(base + Number(days) * 86400000).toISOString();
  }
  await env.DB.prepare("UPDATE users SET plan='premium', premium_until=?, updated_at=CURRENT_TIMESTAMP WHERE telegram_id=?").bind(until, id).run();
  await env.DB.prepare("INSERT INTO subscriptions (telegram_id, plan, status, stars_amount, expires_at, telegram_charge_id) VALUES (?, 'premium', 'active', ?, ?, ?)").bind(id, starsAmount, until, chargeId).run();
  return until;
}

export async function revokePremium(env, chatId) {
  if (!env.DB) return false;
  await ensureUser(env.DB, chatId);
  const id = String(chatId);
  const current = await getUser(env.DB, id);
  if (!current || current.plan !== "premium") return false;
  await env.DB.prepare("UPDATE users SET plan='free', premium_until=NULL, updated_at=CURRENT_TIMESTAMP WHERE telegram_id=?").bind(id).run();
  await env.DB.prepare("UPDATE subscriptions SET status='revoked' WHERE telegram_id=? AND status='active'").bind(id).run();
  return true;
}

export async function getUsage(env, chatId) {
  if (!env.DB) return { used: 0, remaining: Infinity, limit: Infinity, premium: false, admin: false };
  await ensureUser(env.DB, chatId);
  if (isAdmin(chatId, env)) return { used: 0, remaining: Infinity, limit: Infinity, premium: false, admin: true };
  const user = await getUser(env.DB, chatId);
  const premium = hasPremium(user);
  const limit = premium ? PREMIUM_DAILY_OPERATIONS : FREE_DAILY_OPERATIONS;
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM usage WHERE telegram_id=? AND created_at LIKE ?").bind(String(chatId), `${utcDate()}%`).first();
  const used = Number(row?.count || 0);
  return { used, remaining: Math.max(0, limit - used), limit, premium, admin: false };
}

export async function getAdminStats(env) {
  if (!env.DB) return null;
  await ensureCoreTables(env.DB);
  const totals = await env.DB.prepare("SELECT COUNT(*) AS users, SUM(CASE WHEN plan='premium' AND (premium_until IS NULL OR premium_until > CURRENT_TIMESTAMP) THEN 1 ELSE 0 END) AS premium FROM users").first();
  const today = utcDate();
  const todayPhotos = await env.DB.prepare("SELECT COUNT(*) AS count FROM daily_photos WHERE photo_date=?").bind(today).first();
  const todayOperations = await env.DB.prepare("SELECT COUNT(*) AS count FROM usage WHERE created_at LIKE ?").bind(`${today}%`).first();
  const recent = await env.DB.prepare("SELECT telegram_id, username, first_name, plan, premium_until, created_at FROM users ORDER BY created_at DESC LIMIT 20").all();
  return { users: Number(totals?.users || 0), premium: Number(totals?.premium || 0), todayPhotos: Number(todayPhotos?.count || 0), todayOperations: Number(todayOperations?.count || 0), recent: recent?.results || [] };
}

export { FREE_DAILY_OPERATIONS, PREMIUM_DAILY_OPERATIONS, isAdmin, hasPremium };