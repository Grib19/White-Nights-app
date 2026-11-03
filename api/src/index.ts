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

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS },
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

// ---------- обработчики ----------

async function register(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const email = str(body.email, 254).toLowerCase();
  const password = typeof body.password === "string" ? body.password : "";
  const fullName = str(body.full_name, 200);
  const phone = str(body.phone, 30);

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
    return json({ error: "Пользователь с такой почтой уже зарегистрирован" }, 409);
  }

  return json({ status: "pending", message: "Регистрация отправлена комсоставу на подтверждение" }, 201);
}

async function login(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const email = str(body.email, 254).toLowerCase();
  const password = typeof body.password === "string" ? body.password : "";

  const row = await env.DB.prepare(
    `SELECT id, email, phone, full_name, role, status, created_at, password_hash, password_salt
       FROM users WHERE email = ?`,
  )
    .bind(email)
    .first<UserRow & { password_hash: string; password_salt: string }>();

  // Одинаковый ответ для неверной почты и неверного пароля
  const ok = row ? await verifyPassword(password, row.password_hash, row.password_salt) : false;
  if (!row || !ok) return json({ error: "Неверная почта или пароль" }, 401);

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
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

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
