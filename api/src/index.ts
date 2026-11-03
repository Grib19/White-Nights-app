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

// ---------- профили ----------

const USERNAME_RE = /^[\p{L}\p{N}_]{3,32}$/u;
const MAX_UPLOAD = 5 * 1024 * 1024; // 5 МБ на файл
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"];

// Только подтверждённые участники
async function approvedUser(request: Request, env: Env): Promise<UserRow | null> {
  const user = await currentUser(request, env);
  return user && user.status === "approved" ? user : null;
}

function isCommittee(user: UserRow): boolean {
  return COMMITTEE.includes(user.role);
}

// Поля, которые участник заполняет сам и которые видят все
const PUBLIC_FIELDS = [
  "username",
  "position",
  "study_place",
  "course",
  "specialty",
  "birth_date",
  "sizes",
  "achievements",
  "photo_id",
] as const;

// Закрытые поля: видны только себе и комсоставу
const PRIVATE_FIELDS = ["passport", "inn", "snils", "address", "parent_name", "parent_phone", "extra"] as const;

function cleanField(value: unknown, max = 300): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

async function listProfiles(request: Request, env: Env): Promise<Response> {
  const viewer = await approvedUser(request, env);
  if (!viewer) return json({ error: "Нужен вход" }, 401);

  const rows = await env.DB.prepare(
    `SELECT u.id, u.full_name, u.role, p.username, p.position, p.photo_id
       FROM users u LEFT JOIN profiles p ON p.user_id = u.id
      WHERE u.status = 'approved'
      ORDER BY u.full_name`,
  ).all();
  return json({ users: rows.results });
}

async function getProfile(request: Request, env: Env, userId: number): Promise<Response> {
  const viewer = await approvedUser(request, env);
  if (!viewer) return json({ error: "Нужен вход" }, 401);

  const row = await env.DB.prepare(
    `SELECT u.id, u.full_name, u.phone, u.role, u.status,
            p.username, p.position, p.study_place, p.course, p.specialty,
            p.birth_date, p.sizes, p.achievements, p.photo_id
       FROM users u LEFT JOIN profiles p ON p.user_id = u.id
      WHERE u.id = ? AND u.status = 'approved'`,
  )
    .bind(userId)
    .first();
  if (!row) return json({ error: "Участник не найден" }, 404);
  return json({ profile: row });
}

async function getPrivateProfile(request: Request, env: Env, userId: number): Promise<Response> {
  const viewer = await approvedUser(request, env);
  if (!viewer) return json({ error: "Нужен вход" }, 401);
  if (viewer.id !== userId && !isCommittee(viewer)) return json({ error: "Нет доступа" }, 403);

  const row = await env.DB.prepare(
    `SELECT passport, inn, snils, address, parent_name, parent_phone, extra
       FROM private_profiles WHERE user_id = ?`,
  )
    .bind(userId)
    .first();
  return json({ private: row ?? Object.fromEntries(PRIVATE_FIELDS.map((f) => [f, ""])) });
}

async function updateMyProfile(request: Request, env: Env): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const body = await readJson(request);

  const username = cleanField(body.username, 32);
  if (username && !USERNAME_RE.test(username)) {
    return json({ error: "Имя пользователя: от 3 до 32 букв, цифр или _" }, 400);
  }
  const photoId = cleanField(body.photo_id, 64);
  if (photoId) {
    const file = await env.FILES.getWithMetadata<{ uploadedBy: number }>(`file:${photoId}`);
    if (!file.value || file.metadata?.uploadedBy !== user.id) {
      return json({ error: "Фото не найдено" }, 400);
    }
  }

  const v = Object.fromEntries(PUBLIC_FIELDS.map((f) => [f, cleanField(body[f], 300)]));
  v.username = username || null;
  v.photo_id = photoId || null;

  try {
    await env.DB.prepare(
      `INSERT INTO profiles (user_id, username, position, study_place, course, specialty,
                             birth_date, sizes, achievements, photo_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT(user_id) DO UPDATE SET
         username = excluded.username, position = excluded.position,
         study_place = excluded.study_place, course = excluded.course,
         specialty = excluded.specialty, birth_date = excluded.birth_date,
         sizes = excluded.sizes, achievements = excluded.achievements,
         photo_id = excluded.photo_id, updated_at = excluded.updated_at`,
    )
      .bind(
        user.id,
        v.username,
        v.position,
        v.study_place,
        v.course,
        v.specialty,
        v.birth_date,
        v.sizes,
        v.achievements,
        v.photo_id,
      )
      .run();
  } catch {
    // Почти всегда это занятое имя пользователя
    return json({ error: "Это имя пользователя уже занято" }, 409);
  }
  return json({ ok: true });
}

async function updateMyPrivate(request: Request, env: Env): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const body = await readJson(request);
  const v = Object.fromEntries(PRIVATE_FIELDS.map((f) => [f, cleanField(body[f], 300)]));

  await env.DB.prepare(
    `INSERT INTO private_profiles (user_id, passport, inn, snils, address, parent_name, parent_phone, extra)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         passport = excluded.passport, inn = excluded.inn, snils = excluded.snils,
         address = excluded.address, parent_name = excluded.parent_name,
         parent_phone = excluded.parent_phone, extra = excluded.extra`,
  )
    .bind(user.id, v.passport, v.inn, v.snils, v.address, v.parent_name, v.parent_phone, v.extra)
    .run();
  return json({ ok: true });
}

// ---------- общая информация ----------

async function listInfo(request: Request, env: Env): Promise<Response> {
  const viewer = await approvedUser(request, env);
  if (!viewer) return json({ error: "Нужен вход" }, 401);
  const rows = await env.DB.prepare("SELECT slug, title, updated_at FROM info_docs ORDER BY rowid").all();
  return json({ docs: rows.results });
}

async function getInfo(request: Request, env: Env, slug: string): Promise<Response> {
  const viewer = await approvedUser(request, env);
  if (!viewer) return json({ error: "Нужен вход" }, 401);
  const row = await env.DB.prepare("SELECT slug, title, body, updated_at FROM info_docs WHERE slug = ?")
    .bind(slug)
    .first();
  if (!row) return json({ error: "Раздел не найден" }, 404);
  return json({ doc: row });
}

async function updateInfo(request: Request, env: Env, slug: string): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user || !isCommittee(user)) return json({ error: "Нет доступа" }, 403);
  const body = await readJson(request);
  const text = typeof body.body === "string" ? body.body.slice(0, 100000) : null;
  if (text === null) return json({ error: "Пустой текст" }, 400);

  const result = await env.DB.prepare(
    `UPDATE info_docs SET body = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), updated_by = ?
      WHERE slug = ?`,
  )
    .bind(text, user.id, slug)
    .run();
  if (result.meta?.changes === 0) return json({ error: "Раздел не найден" }, 404);
  return json({ ok: true });
}

// ---------- файлы (фото и документы) ----------

async function uploadFile(request: Request, env: Env): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);

  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!ALLOWED_TYPES.includes(type)) return json({ error: "Можно загружать только фото и PDF" }, 400);

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0) return json({ error: "Пустой файл" }, 400);
  if (bytes.byteLength > MAX_UPLOAD) return json({ error: "Файл больше 5 МБ" }, 413);

  const id = randomToken(16);
  await env.FILES.put(`file:${id}`, bytes, {
    metadata: { contentType: type, uploadedBy: user.id },
  });
  return json({ id, url: `/api/files/${id}` }, 201);
}

async function getFile(request: Request, env: Env, id: string): Promise<Response> {
  const viewer = await approvedUser(request, env);
  if (!viewer) return json({ error: "Нужен вход" }, 401);
  if (!/^[A-Za-z0-9_-]{10,64}$/.test(id)) return json({ error: "Не найдено" }, 404);

  const file = await env.FILES.getWithMetadata<{ contentType: string }>(`file:${id}`, "arrayBuffer");
  if (!file.value) return json({ error: "Не найдено" }, 404);
  return new Response(file.value, {
    headers: {
      "content-type": file.metadata?.contentType ?? "application/octet-stream",
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
      ...CORS,
    },
  });
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

      if (method === "GET" && path === "/api/profiles") return await listProfiles(request, env);
      if (method === "PUT" && path === "/api/profiles/me") return await updateMyProfile(request, env);
      if (method === "PUT" && path === "/api/profiles/me/private") return await updateMyPrivate(request, env);
      const profileMatch = path.match(/^\/api\/profiles\/(\d+)(\/private)?$/);
      if (method === "GET" && profileMatch) {
        const id = Number(profileMatch[1]);
        return profileMatch[2]
          ? await getPrivateProfile(request, env, id)
          : await getProfile(request, env, id);
      }

      if (method === "GET" && path === "/api/info") return await listInfo(request, env);
      const infoMatch = path.match(/^\/api\/info\/([a-z0-9-]{1,40})$/);
      if (infoMatch && method === "GET") return await getInfo(request, env, infoMatch[1]);
      if (infoMatch && method === "PUT") return await updateInfo(request, env, infoMatch[1]);

      if (method === "POST" && path === "/api/files") return await uploadFile(request, env);
      const fileMatch = path.match(/^\/api\/files\/([A-Za-z0-9_-]+)$/);
      if (method === "GET" && fileMatch) return await getFile(request, env, fileMatch[1]);

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
