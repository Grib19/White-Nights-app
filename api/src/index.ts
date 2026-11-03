// API приложения White Nights: регистрация, вход, подтверждение комсостава.
// Всё работает на Cloudflare Workers, база — D1, без сторонних сервисов.

export interface Env {
  DB: D1Database;
  FILES: KVNamespace;
}

type Role = "candidate" | "fighter" | "master" | "commissar" | "commander";
type Status = "pending" | "approved" | "rejected";

const ROLES: Role[] = ["candidate", "fighter", "master", "commissar", "commander"];
// Роли, которые может назначать только командир или комиссар
const SENIOR_ROLES: Role[] = ["master", "commissar", "commander"];
// Роли, которые могут подтверждать регистрацию
const COMMITTEE: Role[] = ["master", "commissar", "commander"];

const SESSION_DAYS = 30;
const PBKDF2_ITERATIONS = 100000; // максимум, который поддерживает Workers

// ---------- утилиты ----------

const enc = new TextEncoder();

// Разрешаем обращения из браузера (сайт может открываться с другого адреса).
// Авторизация идёт через заголовок Authorization, не через cookie, поэтому так безопасно.
const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
};

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS, ...extra },
  });
}

function toBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function randomToken(bytes = 32): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return toBase64Url(b);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function derivePassword(password: string, salt: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    key,
    256,
  );
  return toBase64(new Uint8Array(bits));
}

async function hashPassword(password: string): Promise<{ hash: string; salt: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { hash: await derivePassword(password, salt), salt: toBase64(salt) };
}

async function verifyPassword(password: string, hash: string, saltB64: string): Promise<boolean> {
  const candidate = await derivePassword(password, fromBase64(saltB64));
  // Сравнение без раннего выхода, чтобы не утекала информация по времени
  if (candidate.length !== hash.length) return false;
  let diff = 0;
  for (let i = 0; i < candidate.length; i++) diff |= candidate.charCodeAt(i) ^ hash.charCodeAt(i);
  return diff === 0;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function str(value: unknown, max = 200): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

// ---------- пользователи и сессии ----------

interface UserRow {
  id: number;
  email: string;
  phone: string;
  full_name: string;
  role: Role;
  status: Status;
  created_at: string;
}

function publicUser(u: UserRow) {
  return {
    id: u.id,
    email: u.email,
    phone: u.phone,
    full_name: u.full_name,
    role: u.role,
    status: u.status,
    created_at: u.created_at,
  };
}

// Возвращает пользователя по токену из заголовка Authorization: Bearer <token>
async function currentUser(request: Request, env: Env): Promise<UserRow | null> {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;

  const tokenHash = await sha256Hex(match[1]);
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.phone, u.full_name, u.role, u.status, u.created_at, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
  )
    .bind(tokenHash)
    .first<UserRow & { expires_at: string }>();

  if (!row) return null;
  if (row.expires_at <= new Date().toISOString()) {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
    return null;
  }
  return row;
}

// ---------- защита от перебора ----------

interface Limit {
  max: number; // сколько попыток разрешено
  windowMs: number; // за какое время они считаются
  blockMs: number; // на сколько блокируем, когда попыток слишком много
}

const LIMITS: Record<string, Limit> = {
  // По одной почте: пять неудач за 15 минут — блокировка на 15 минут.
  loginEmail: { max: 5, windowMs: 15 * 60 * 1000, blockMs: 15 * 60 * 1000 },
  // По одному адресу в сети: двадцать неудач за 15 минут — блокировка на 30 минут.
  // Так не подберут пароль, перебирая разные почты с одного компьютера.
  loginIp: { max: 20, windowMs: 15 * 60 * 1000, blockMs: 30 * 60 * 1000 },
  // Регистрации с одного адреса: пять за час, иначе список заявок завалят мусором.
  register: { max: 5, windowMs: 60 * 60 * 1000, blockMs: 60 * 60 * 1000 },
};

function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}

// Сколько секунд осталось до разблокировки. Ноль — значит не заблокировано.
async function blockedFor(env: Env, key: string): Promise<number> {
  const row = await env.DB.prepare("SELECT blocked_until FROM rate_limits WHERE limit_key = ?")
    .bind(key)
    .first<{ blocked_until: string | null }>();
  if (!row?.blocked_until) return 0;
  const left = Date.parse(row.blocked_until) - Date.now();
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

// Засчитывает попытку. Когда их становится больше разрешённого, выставляет блокировку.
async function recordAttempt(env: Env, key: string, limit: Limit): Promise<void> {
  const now = Date.now();
  const row = await env.DB.prepare(
    "SELECT count, window_start FROM rate_limits WHERE limit_key = ?",
  )
    .bind(key)
    .first<{ count: number; window_start: string }>();

  // Если прошлое окно уже истекло, счёт начинается заново
  const inWindow = !!row && now - Date.parse(row.window_start) < limit.windowMs;
  const count = (inWindow ? row!.count : 0) + 1;
  const windowStart = inWindow ? row!.window_start : new Date(now).toISOString();
  const blockedUntil = count >= limit.max ? new Date(now + limit.blockMs).toISOString() : null;

  await env.DB.prepare(
    `INSERT INTO rate_limits (limit_key, count, window_start, blocked_until) VALUES (?, ?, ?, ?)
       ON CONFLICT(limit_key) DO UPDATE SET count = ?, window_start = ?, blocked_until = ?`,
  )
    .bind(key, count, windowStart, blockedUntil, count, windowStart, blockedUntil)
    .run();
}

async function clearLimit(env: Env, key: string): Promise<void> {
  await env.DB.prepare("DELETE FROM rate_limits WHERE limit_key = ?").bind(key).run();
}

// Изредка убираем старые записи, чтобы таблицы не росли без конца.
async function cleanupSometimes(env: Env): Promise<void> {
  if (Math.random() > 0.02) return;
  const now = new Date().toISOString();
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare(
    `DELETE FROM rate_limits
      WHERE (blocked_until IS NULL OR blocked_until < ?) AND window_start < ?`,
  )
    .bind(now, dayAgo)
    .run();
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now).run();
}

function tooMany(seconds: number): Response {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return json(
    { error: `Слишком много попыток. Попробуйте через ${minutes} мин.` },
    429,
    { "retry-after": String(seconds) },
  );
}

// Проверка пароля для несуществующей почты: считаем столько же, сколько для настоящей,
// чтобы по времени ответа нельзя было узнать, зарегистрирован ли такой адрес.
const DUMMY_SALT = new Uint8Array(16);
async function fakeVerify(password: string): Promise<boolean> {
  await derivePassword(password, DUMMY_SALT);
  return false;
}

// ---------- обработчики ----------

async function register(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const email = str(body.email, 254).toLowerCase();
  const password = typeof body.password === "string" ? body.password : "";
  const fullName = str(body.full_name, 200);
  const phone = str(body.phone, 30);

  // Не даём забрасывать заявками с одного адреса
  const ipKey = `register:ip:${clientIp(request)}`;
  const blocked = await blockedFor(env, ipKey);
  if (blocked > 0) return tooMany(blocked);

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Некорректная почта" }, 400);
  if (password.length < 8) return json({ error: "Пароль должен быть не короче 8 символов" }, 400);
  if (fullName.length < 2) return json({ error: "Укажите ФИО" }, 400);
  if (phone.length < 5) return json({ error: "Укажите номер телефона" }, 400);

  const { hash, salt } = await hashPassword(password);
  try {
    await env.DB.prepare(
      `INSERT INTO users (email, phone, full_name, password_hash, password_salt)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(email, phone, fullName, hash, salt)
      .run();
  } catch {
    await recordAttempt(env, ipKey, LIMITS.register);
    return json({ error: "Пользователь с такой почтой уже зарегистрирован" }, 409);
  }

  await recordAttempt(env, ipKey, LIMITS.register);
  return json({ status: "pending", message: "Регистрация отправлена комсоставу на подтверждение" }, 201);
}

async function login(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const email = str(body.email, 254).toLowerCase();
  const password = typeof body.password === "string" ? body.password : "";

  // Две защиты сразу: по почте (подбор пароля к одному аккаунту)
  // и по адресу в сети (перебор разных почт с одного компьютера)
  const ipKey = `login:ip:${clientIp(request)}`;
  const emailKey = `login:email:${email}`;
  const blocked = Math.max(
    await blockedFor(env, ipKey),
    email ? await blockedFor(env, emailKey) : 0,
  );
  if (blocked > 0) return tooMany(blocked);

  const row = await env.DB.prepare(
    `SELECT id, email, phone, full_name, role, status, created_at, password_hash, password_salt
       FROM users WHERE email = ?`,
  )
    .bind(email)
    .first<UserRow & { password_hash: string; password_salt: string }>();

  // Одинаковый ответ и одинаковое время для неверной почты и неверного пароля
  const ok = row
    ? await verifyPassword(password, row.password_hash, row.password_salt)
    : await fakeVerify(password);
  if (!row || !ok) {
    await recordAttempt(env, ipKey, LIMITS.loginIp);
    if (email) await recordAttempt(env, emailKey, LIMITS.loginEmail);
    return json({ error: "Неверная почта или пароль" }, 401);
  }

  // Пароль верный: снимаем счётчик по этой почте.
  // Счётчик по адресу в сети не трогаем, иначе его можно было бы сбрасывать
  // входом в один известный аккаунт и продолжать перебор остальных.
  await clearLimit(env, emailKey);

  if (row.status !== "approved") {
    return json(
      { error: "Аккаунт ещё не подтверждён комсоставом", status: row.status },
      403,
    );
  }

  const token = randomToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(await sha256Hex(token), row.id, expires)
    .run();

  return json({ token, user: publicUser(row) });
}

async function logout(request: Request, env: Env): Promise<Response> {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (match) {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?")
      .bind(await sha256Hex(match[1]))
      .run();
  }
  return json({ ok: true });
}

async function me(request: Request, env: Env): Promise<Response> {
  const user = await currentUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  return json({ user: publicUser(user) });
}

async function listPending(request: Request, env: Env): Promise<Response> {
  const user = await currentUser(request, env);
  if (!user || user.status !== "approved" || !COMMITTEE.includes(user.role)) {
    return json({ error: "Нет доступа" }, 403);
  }
  const rows = await env.DB.prepare(
    `SELECT id, email, phone, full_name, role, status, created_at
       FROM users WHERE status = 'pending' ORDER BY created_at`,
  ).all<UserRow>();
  return json({ users: rows.results.map(publicUser) });
}

async function decide(
  request: Request,
  env: Env,
  userId: number,
  action: "approve" | "reject",
): Promise<Response> {
  const admin = await currentUser(request, env);
  if (!admin || admin.status !== "approved" || !COMMITTEE.includes(admin.role)) {
    return json({ error: "Нет доступа" }, 403);
  }

  const body = await readJson(request);
  const requestedRole = typeof body.role === "string" ? (body.role as Role) : "candidate";
  if (!ROLES.includes(requestedRole)) return json({ error: "Неизвестная роль" }, 400);

  // Назначать старшие роли может только командир или комиссар
  const canAssignSenior = admin.role === "commander" || admin.role === "commissar";
  if (action === "approve" && SENIOR_ROLES.includes(requestedRole) && !canAssignSenior) {
    return json({ error: "Назначать эту роль могут только командир или комиссар" }, 403);
  }

  if (action === "approve") {
    await env.DB.prepare("UPDATE users SET status = 'approved', role = ? WHERE id = ?")
      .bind(requestedRole, userId)
      .run();
  } else {
    await env.DB.prepare("UPDATE users SET status = 'rejected' WHERE id = ?").bind(userId).run();
  }
  return json({ ok: true });
}

// ---------- маршрутизация ----------

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    // Уборка идёт в фоне и не задерживает ответ
    ctx.waitUntil(cleanupSometimes(env).catch(() => undefined));

    try {
      if (method === "POST" && path === "/api/register") return await register(request, env);
      if (method === "POST" && path === "/api/login") return await login(request, env);
      if (method === "POST" && path === "/api/logout") return await logout(request, env);
      if (method === "GET" && path === "/api/me") return await me(request, env);
      if (method === "GET" && path === "/api/admin/pending") return await listPending(request, env);

      const adminMatch = path.match(/^\/api\/admin\/users\/(\d+)\/(approve|reject)$/);
      if (method === "POST" && adminMatch) {
        return await decide(request, env, Number(adminMatch[1]), adminMatch[2] as "approve" | "reject");
      }

      return json({ error: "Не найдено" }, 404);
    } catch {
      // Подробности ошибки не отдаём наружу
      return json({ error: "Внутренняя ошибка сервера" }, 500);
    }
  },
};
