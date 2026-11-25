// API приложения White Nights: регистрация, вход, подтверждение комсостава.
// Всё работает на Cloudflare Workers, база — D1, без сторонних сервисов.

export interface Env {
  DB: D1Database;
  FILES: KVNamespace;
  // Полный ключ Ably (appId.keyId:secret), задаётся командой wrangler secret put ABLY_API_KEY
  ABLY_API_KEY?: string;
  // Cloudflare Calls TURN: id ключа и API-токен (wrangler secret put TURN_KEY_ID / TURN_KEY_API_TOKEN)
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
  // Ключи для push-уведомлений: публичный и приватный (wrangler secret put)
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  // Google Drive (галерея): OAuth-клиент, задаётся командой wrangler secret put
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  // Workers AI (расшифровка голосовых), привязка задаётся в wrangler.toml
  AI: Ai;
}

type Role = "candidate" | "fighter" | "master" | "commissar" | "commander" | "press";
type Status = "pending" | "approved" | "rejected";

const ROLES: Role[] = ["candidate", "fighter", "master", "commissar", "commander", "press"];
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
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, x-song-title, x-song-author, x-file-name, x-caption",
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

// Дата рождения в формате ГГГГ-ММ-ДД, не в будущем и не раньше 1900 года
function isValidBirthDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return false;
  return value >= "1900-01-01" && date.getTime() <= Date.now();
}

async function register(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const email = str(body.email, 254).toLowerCase();
  const password = typeof body.password === "string" ? body.password : "";
  const fullName = str(body.full_name, 200);
  const phone = str(body.phone, 30);
  const birthDate = str(body.birth_date, 10);

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Некорректная почта" }, 400);
  if (password.length < 8) return json({ error: "Пароль должен быть не короче 8 символов" }, 400);
  if (fullName.length < 2) return json({ error: "Укажите ФИО" }, 400);
  if (phone.length < 5) return json({ error: "Укажите номер телефона" }, 400);
  if (!isValidBirthDate(birthDate)) return json({ error: "Укажите дату рождения" }, 400);

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

  // Дата рождения сразу попадает в профиль
  await env.DB.prepare(
    `INSERT INTO profiles (user_id, birth_date)
     SELECT id, ? FROM users WHERE email = ?`,
  )
    .bind(birthDate, email)
    .run();

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

async function getProfileByUsername(request: Request, env: Env, name: string): Promise<Response> {
  const found = await env.DB.prepare("SELECT user_id FROM profiles WHERE lower(username) = lower(?)")
    .bind(name)
    .first<{ user_id: number }>();
  if (!found) return json({ error: "Пользователь не найден" }, 404);
  return await getProfile(request, env, found.user_id);
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
  if (username) {
    if (username.toLowerCase() === "all") return json({ error: "Это имя зарезервировано" }, 400);
    const taken = await env.DB.prepare("SELECT user_id FROM profiles WHERE lower(username) = lower(?) AND user_id <> ?")
      .bind(username, user.id)
      .first();
    if (taken) return json({ error: "Это имя пользователя уже занято" }, 400);
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
  const rows = await env.DB.prepare("SELECT slug, title, updated_at FROM info_docs ORDER BY sort_order, rowid").all();
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

// Писать в «Важное» могут комсостав и участники, которым комсостав разрешил
async function canPostImportant(env: Env, user: UserRow): Promise<boolean> {
  if (isCommittee(user)) return true;
  const row = await env.DB.prepare("SELECT can_post_important FROM users WHERE id = ?")
    .bind(user.id)
    .first<{ can_post_important: number }>();
  return !!row?.can_post_important;
}

// Список подтверждённых участников с правом писать в «Важное» (только комсостав)
async function listMembersAccess(request: Request, env: Env): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user || !isCommittee(user)) return json({ error: "Нет доступа" }, 403);
  const rows = await env.DB.prepare(
    "SELECT id, full_name, role, can_post_important FROM users WHERE status = 'approved' ORDER BY full_name",
  ).all();
  return json({ members: rows.results });
}

async function setImportantAccess(request: Request, env: Env, id: number): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user || !isCommittee(user)) return json({ error: "Нет доступа" }, 403);
  const body = await readJson(request);
  const allow = body.allow === true ? 1 : 0;
  const result = await env.DB.prepare("UPDATE users SET can_post_important = ? WHERE id = ? AND status = 'approved'")
    .bind(allow, id)
    .run();
  if (result.meta?.changes === 0) return json({ error: "Участник не найден" }, 404);
  return json({ ok: true });
}

// ---------- лента новостей ----------
// Любой подтверждённый участник пишет пост: текст, фото, любой файл и/или опрос.
// Удалить может автор или комсостав.

const MAX_ATTACHMENT = 20 * 1024 * 1024;
const MAX_POLL_OPTIONS = 10;

interface PollRow {
  id: number;
  post_id: number;
  question: string;
  multiple: number;
  lock_vote: number;
  anonymous: number;
  ends_at: string | null;
}

// Опросы для списка постов: варианты, число голосов и голоса самого участника
async function loadPolls(env: Env, postIds: number[], userId: number): Promise<Map<number, unknown>> {
  const result = new Map<number, unknown>();
  if (postIds.length === 0) return result;
  const marks = postIds.map(() => "?").join(",");
  const pollRows = (
    await env.DB.prepare(
      `SELECT id, post_id, question, multiple, lock_vote, anonymous, ends_at FROM polls WHERE post_id IN (${marks})`,
    )
      .bind(...postIds)
      .all<PollRow>()
  ).results;
  if (pollRows.length === 0) return result;

  const pollIds = pollRows.map((p) => p.id);
  const pMarks = pollIds.map(() => "?").join(",");
  const optRows = (
    await env.DB.prepare(
      `SELECT o.id, o.poll_id, o.text,
              (SELECT COUNT(*) FROM poll_votes v WHERE v.option_id = o.id) AS votes
         FROM poll_options o WHERE o.poll_id IN (${pMarks}) ORDER BY o.poll_id, o.position, o.id`,
    )
      .bind(...pollIds)
      .all<{ id: number; poll_id: number; text: string; votes: number }>()
  ).results;
  const myRows = (
    await env.DB.prepare(`SELECT poll_id, option_id FROM poll_votes WHERE user_id = ? AND poll_id IN (${pMarks})`)
      .bind(userId, ...pollIds)
      .all<{ poll_id: number; option_id: number }>()
  ).results;
  // Кто проголосовал — только в неанонимных опросах
  const voterRows = (
    await env.DB.prepare(
      `SELECT v.poll_id, v.option_id, u.full_name
         FROM poll_votes v JOIN users u ON u.id = v.user_id
        WHERE v.poll_id IN (${pMarks})
        ORDER BY u.full_name`,
    )
      .bind(...pollIds)
      .all<{ poll_id: number; option_id: number; full_name: string }>()
  ).results;

  const now = Date.now();
  for (const p of pollRows) {
    const anonymous = !!p.anonymous;
    result.set(p.post_id, {
      id: p.id,
      question: p.question,
      multiple: !!p.multiple,
      lock_vote: !!p.lock_vote,
      anonymous,
      ends_at: p.ends_at,
      ended: !!p.ends_at && new Date(p.ends_at).getTime() <= now,
      options: optRows
        .filter((o) => o.poll_id === p.id)
        .map((o) => ({
          id: o.id,
          text: o.text,
          votes: o.votes,
          ...(anonymous
            ? {}
            : { voters: voterRows.filter((v) => v.poll_id === p.id && v.option_id === o.id).map((v) => v.full_name) }),
        })),
      my_votes: myRows.filter((m) => m.poll_id === p.id).map((m) => m.option_id),
    });
  }
  return result;
}

async function listPosts(request: Request, env: Env): Promise<Response> {
  const viewer = await approvedUser(request, env);
  if (!viewer) return json({ error: "Нужен вход" }, 401);
  const url = new URL(request.url);
  const section = url.searchParams.get("section") === "important" ? "important" : "posts";
  // Постраничная загрузка: before — id последнего поста, который уже на экране; limit — сколько дать
  const before = Math.max(0, parseInt(url.searchParams.get("before") ?? "0", 10) || 0);
  const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get("limit") ?? "20", 10) || 20));
  const fetched = (
    await env.DB.prepare(
      `SELECT p.id, p.body, p.photo_id, p.text_position, p.attachment_id, p.attachment_name,
              p.created_at, p.author_id, u.full_name AS author_name,
              (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comments_count
         FROM posts p JOIN users u ON u.id = p.author_id
        WHERE p.section = ? AND (? = 0 OR p.id < ?)
        ORDER BY p.id DESC LIMIT ?`,
    )
      .bind(section, before, before, limit + 1)
      .all()
  ).results as Array<{ id: number }>;
  // Лишняя запись нужна только чтобы понять, есть ли ещё посты
  const hasMore = fetched.length > limit;
  const rows = hasMore ? fetched.slice(0, limit) : fetched;
  const polls = await loadPolls(
    env,
    rows.map((r) => r.id),
    viewer.id,
  );
  const reactions = await loadReactions(
    env,
    "post",
    rows.map((r) => r.id),
    viewer.id,
  );
  return json({
    posts: rows.map((r) => ({ ...r, poll: polls.get(r.id) ?? null, reactions: reactions.get(r.id) ?? [] })),
    viewer_id: viewer.id,
    viewer_committee: isCommittee(viewer),
    can_post_important: await canPostImportant(env, viewer),
    has_more: hasMore,
  });
}

async function addPost(request: Request, env: Env): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const body = await readJson(request);
  const text = str(body.body, 2000);
  const photoId = str(body.photo_id, 64);
  const attachmentId = str(body.attachment_id, 64);
  const textPosition = body.text_position === "bottom" ? "bottom" : "top";
  const section = body.section === "important" ? "important" : "posts";
  if (section === "important" && !(await canPostImportant(env, user))) {
    return json({ error: "В «Важное» может писать только комсостав и отмеченные им участники" }, 403);
  }

  let poll: {
    question: string;
    options: string[];
    multiple: boolean;
    lock: boolean;
    anonymous: boolean;
    endsAt: string | null;
  } | null = null;
  if (body.poll && typeof body.poll === "object") {
    const p = body.poll as Record<string, unknown>;
    const question = str(p.question, 300);
    const options = Array.isArray(p.options) ? p.options.map((o) => str(o, 200)).filter(Boolean) : [];
    if (!question) return json({ error: "Напишите тему опроса" }, 400);
    if (options.length < 2) return json({ error: "В опросе должно быть не меньше двух вариантов" }, 400);
    if (options.length > MAX_POLL_OPTIONS) return json({ error: "В опросе не больше 10 вариантов" }, 400);
    let endsAt: string | null = null;
    if (p.ends_at) {
      const t = Date.parse(String(p.ends_at));
      if (Number.isNaN(t) || t <= Date.now()) return json({ error: "Время окончания опроса должно быть в будущем" }, 400);
      endsAt = new Date(t).toISOString();
    }
    poll = {
      question,
      options,
      multiple: p.multiple === true,
      lock: p.lock === true,
      anonymous: p.anonymous === true,
      endsAt,
    };
  }
  if (!text && !photoId && !attachmentId && !poll) {
    return json({ error: "Напишите текст, добавьте файл или опрос" }, 400);
  }

  if (photoId) {
    const file = await env.FILES.getWithMetadata<{ uploadedBy: number; contentType: string }>(`file:${photoId}`);
    if (!file.value || file.metadata?.uploadedBy !== user.id || !file.metadata?.contentType?.startsWith("image/")) {
      return json({ error: "Фото не найдено" }, 400);
    }
  }

  let attachmentName: string | null = null;
  if (attachmentId) {
    if (!/^[A-Za-z0-9_-]{10,64}$/.test(attachmentId)) return json({ error: "Файл не найден" }, 400);
    const att = await env.FILES.getWithMetadata<{ uploadedBy: number; name: string }>(`att:${attachmentId}`);
    if (!att.value || att.metadata?.uploadedBy !== user.id) return json({ error: "Файл не найден" }, 400);
    attachmentName = att.metadata.name;
  }

  const result = await env.DB.prepare(
    `INSERT INTO posts (author_id, body, photo_id, text_position, attachment_id, attachment_name, section)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(user.id, text, photoId || null, textPosition, attachmentId || null, attachmentName, section)
    .run();
  const postId = result.meta?.last_row_id;

  if (poll && postId) {
    const pollResult = await env.DB.prepare(
      "INSERT INTO polls (post_id, question, multiple, lock_vote, anonymous, ends_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(postId, poll.question, poll.multiple ? 1 : 0, poll.lock ? 1 : 0, poll.anonymous ? 1 : 0, poll.endsAt)
      .run();
    const pollId = pollResult.meta?.last_row_id;
    await env.DB.batch(
      poll.options.map((optText, i) =>
        env.DB.prepare("INSERT INTO poll_options (poll_id, text, position) VALUES (?, ?, ?)").bind(pollId, optText, i),
      ),
    );
  }
  return json({ ok: true, id: postId }, 201);
}

async function deletePost(request: Request, env: Env, id: number): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const post = await env.DB.prepare("SELECT author_id, attachment_id FROM posts WHERE id = ?")
    .bind(id)
    .first<{ author_id: number; attachment_id: string | null }>();
  if (!post) return json({ error: "Пост не найден" }, 404);
  if (post.author_id !== user.id && !isCommittee(user)) return json({ error: "Нет доступа" }, 403);

  await env.DB.prepare("DELETE FROM poll_votes WHERE poll_id IN (SELECT id FROM polls WHERE post_id = ?)").bind(id).run();
  await env.DB.prepare("DELETE FROM poll_options WHERE poll_id IN (SELECT id FROM polls WHERE post_id = ?)").bind(id).run();
  await env.DB.prepare("DELETE FROM polls WHERE post_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM reactions WHERE target_type = 'comment' AND target_id IN (SELECT id FROM comments WHERE post_id = ?)").bind(id).run();
  await env.DB.prepare("DELETE FROM comments WHERE post_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM reactions WHERE target_type = 'post' AND target_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(id).run();
  if (post.attachment_id) await env.FILES.delete(`att:${post.attachment_id}`);
  return json({ ok: true });
}

// Голос в опросе: одиночный выбор заменяет прошлый голос, множественный — переключает вариант.
// «Запретить отмену голоса»: после голоса изменить его нельзя.
async function votePoll(request: Request, env: Env, pollId: number): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const body = await readJson(request);
  const optionId = Number(body.option_id);

  const poll = await env.DB.prepare("SELECT id, multiple, lock_vote, ends_at FROM polls WHERE id = ?")
    .bind(pollId)
    .first<{ id: number; multiple: number; lock_vote: number; ends_at: string | null }>();
  if (!poll) return json({ error: "Опрос не найден" }, 404);
  if (poll.ends_at && new Date(poll.ends_at).getTime() <= Date.now()) {
    return json({ error: "Голосование завершено" }, 400);
  }
  const option = await env.DB.prepare("SELECT id FROM poll_options WHERE id = ? AND poll_id = ?")
    .bind(optionId, pollId)
    .first();
  if (!option) return json({ error: "Вариант не найден" }, 400);

  const mine = (
    await env.DB.prepare("SELECT option_id FROM poll_votes WHERE poll_id = ? AND user_id = ?")
      .bind(pollId, user.id)
      .all<{ option_id: number }>()
  ).results;
  const has = mine.some((m) => m.option_id === optionId);

  if (poll.lock_vote) {
    // Отмена голоса запрещена; при одиночном выборе смена варианта — тоже отмена прошлого
    if (has) return json({ error: "Голос нельзя отменить" }, 403);
    if (!poll.multiple && mine.length > 0) return json({ error: "Голос нельзя изменить" }, 403);
  }

  if (has) {
    await env.DB.prepare("DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ? AND option_id = ?")
      .bind(pollId, user.id, optionId)
      .run();
  } else {
    if (!poll.multiple) {
      await env.DB.prepare("DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ?").bind(pollId, user.id).run();
    }
    await env.DB.prepare("INSERT OR IGNORE INTO poll_votes (poll_id, option_id, user_id) VALUES (?, ?, ?)")
      .bind(pollId, optionId, user.id)
      .run();
  }
  return json({ ok: true });
}

// Любой файл для поста: до 20 МБ, хранится в KV, скачивается по ссылке
async function uploadAttachment(request: Request, env: Env): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const name = decodeHeader(request.headers.get("x-file-name"), 200);
  if (!name) return json({ error: "Не указано имя файла" }, 400);
  const type =
    (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase() || "application/octet-stream";
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0) return json({ error: "Пустой файл" }, 400);
  if (bytes.byteLength > MAX_ATTACHMENT) return json({ error: "Файл больше 20 МБ" }, 413);

  const id = randomToken(16);
  await env.FILES.put(`att:${id}`, bytes, { metadata: { contentType: type, name, uploadedBy: user.id } });
  return json({ id, name }, 201);
}

async function getAttachment(request: Request, env: Env, id: string): Promise<Response> {
  const viewer = await approvedUser(request, env);
  if (!viewer) return json({ error: "Нужен вход" }, 401);
  if (!/^[A-Za-z0-9_-]{10,64}$/.test(id)) return json({ error: "Не найдено" }, 404);
  const file = await env.FILES.getWithMetadata<{ contentType: string; name: string }>(`att:${id}`, "arrayBuffer");
  if (!file.value) return json({ error: "Не найдено" }, 404);
  const name = file.metadata?.name ?? "file";
  return new Response(file.value, {
    headers: {
      "content-type": file.metadata?.contentType ?? "application/octet-stream",
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
      ...CORS,
    },
  });
}

// ---------- реакции и комментарии ----------

const EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🔥", "👏", "🙏"];

interface ReactionSummary {
  emoji: string;
  count: number;
  mine: boolean;
  users: string[];
}

// Реакции для набора постов или комментариев: сколько каждого эмодзи и поставил ли их сам участник
async function loadReactions(
  env: Env,
  type: "post" | "comment" | "message",
  ids: number[],
  userId: number,
): Promise<Map<number, ReactionSummary[]>> {
  const result = new Map<number, ReactionSummary[]>();
  if (ids.length === 0) return result;
  const marks = ids.map(() => "?").join(",");
  const rows = (
    await env.DB.prepare(
      `SELECT target_id, emoji, COUNT(*) AS count,
              SUM(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS mine
         FROM reactions WHERE target_type = ? AND target_id IN (${marks})
        GROUP BY target_id, emoji ORDER BY count DESC`,
    )
      .bind(userId, type, ...ids)
      .all<{ target_id: number; emoji: string; count: number; mine: number }>()
  ).results;
  for (const r of rows) {
    const list = result.get(r.target_id) ?? [];
    list.push({ emoji: r.emoji, count: r.count, mine: r.mine > 0, users: [] });
    result.set(r.target_id, list);
  }
  // Имена тех, кто поставил реакцию (для подсказки при наведении)
  const who = (
    await env.DB.prepare(
      `SELECT r.target_id, r.emoji, u.full_name
         FROM reactions r JOIN users u ON u.id = r.user_id
        WHERE r.target_type = ? AND r.target_id IN (${marks})
        ORDER BY u.full_name`,
    )
      .bind(type, ...ids)
      .all<{ target_id: number; emoji: string; full_name: string }>()
  ).results;
  for (const w of who) {
    const item = result.get(w.target_id)?.find((x) => x.emoji === w.emoji);
    if (item) item.users.push(w.full_name);
  }
  return result;
}

// Поставить эмодзи: повторный нажатие на тот же эмодзи убирает реакцию, другой — заменяет
async function toggleReaction(request: Request, env: Env): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const body = await readJson(request);
  const type =
    body.target_type === "post" ? "post" : body.target_type === "comment" ? "comment" : body.target_type === "message" ? "message" : null;
  const id = Number(body.target_id);
  const emoji = typeof body.emoji === "string" ? body.emoji : "";
  if (!type || !Number.isInteger(id) || id <= 0) return json({ error: "Неверный объект" }, 400);
  if (!EMOJIS.includes(emoji)) return json({ error: "Такой реакции нет" }, 400);

  const table = type === "post" ? "posts" : type === "comment" ? "comments" : "messages";
  // chat_id есть только у сообщений; у постов и комментариев такой колонки нет
  const exists = await env.DB.prepare(`SELECT id${type === "message" ? ", chat_id" : ""} FROM ${table} WHERE id = ?`)
    .bind(id)
    .first<{ id: number; chat_id?: number }>();
  if (!exists) return json({ error: "Не найдено" }, 404);
  let chatIdForEvent: number | null = null;
  if (type === "message") {
    const chat = await chatById(env, exists.chat_id ?? 0);
    if (!chat || !(await canAccessChat(env, user, chat))) return json({ error: "Нет доступа" }, 403);
    chatIdForEvent = chat.id;
  }

  const current = await env.DB.prepare(
    "SELECT emoji FROM reactions WHERE target_type = ? AND target_id = ? AND user_id = ?",
  )
    .bind(type, id, user.id)
    .first<{ emoji: string }>();
  if (current?.emoji === emoji) {
    await env.DB.prepare("DELETE FROM reactions WHERE target_type = ? AND target_id = ? AND user_id = ?")
      .bind(type, id, user.id)
      .run();
  } else {
    await env.DB.prepare(
      `INSERT INTO reactions (target_type, target_id, user_id, emoji) VALUES (?, ?, ?, ?)
       ON CONFLICT(target_type, target_id, user_id) DO UPDATE SET emoji = excluded.emoji`,
    )
      .bind(type, id, user.id, emoji)
      .run();
  }
  if (chatIdForEvent !== null) await ablyPublish(env, chatIdForEvent, "react", { id, chat_id: chatIdForEvent });
  return json({ ok: true });
}

async function listComments(request: Request, env: Env, postId: number): Promise<Response> {
  const viewer = await approvedUser(request, env);
  if (!viewer) return json({ error: "Нужен вход" }, 401);
  const rows = (
    await env.DB.prepare(
      `SELECT c.id, c.body, c.created_at, c.author_id, u.full_name AS author_name
         FROM comments c JOIN users u ON u.id = c.author_id
        WHERE c.post_id = ? ORDER BY c.created_at, c.id`,
    )
      .bind(postId)
      .all()
  ).results as Array<{ id: number }>;
  const reactions = await loadReactions(
    env,
    "comment",
    rows.map((r) => r.id),
    viewer.id,
  );
  return json({
    comments: rows.map((r) => ({ ...r, reactions: reactions.get(r.id) ?? [] })),
    viewer_id: viewer.id,
    viewer_committee: isCommittee(viewer),
  });
}

async function addComment(request: Request, env: Env, postId: number): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const body = await readJson(request);
  const text = str(body.body, 1000);
  if (!text) return json({ error: "Напишите комментарий" }, 400);
  const post = await env.DB.prepare("SELECT id FROM posts WHERE id = ?").bind(postId).first();
  if (!post) return json({ error: "Пост не найден" }, 404);
  await env.DB.prepare("INSERT INTO comments (post_id, author_id, body) VALUES (?, ?, ?)")
    .bind(postId, user.id, text)
    .run();
  return json({ ok: true }, 201);
}

async function deleteComment(request: Request, env: Env, id: number): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const row = await env.DB.prepare("SELECT author_id FROM comments WHERE id = ?")
    .bind(id)
    .first<{ author_id: number }>();
  if (!row) return json({ error: "Комментарий не найден" }, 404);
  if (row.author_id !== user.id && !isCommittee(user)) return json({ error: "Нет доступа" }, 403);
  await env.DB.prepare("DELETE FROM reactions WHERE target_type = 'comment' AND target_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM comments WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

// ---------- песни ----------
// Аудио хранится в KV (ключ song:<id>), список и порядок — в таблице songs.
// Загружать может только комсостав.

const ALLOWED_AUDIO = ["audio/mpeg", "audio/mp4", "audio/x-m4a", "audio/wav", "audio/ogg"];
const MAX_AUDIO = 20 * 1024 * 1024;

// Заголовки HTTP передаются только латиницей, поэтому название и автор приходят в URL-кодировке
function decodeHeader(value: string | null, max: number): string {
  if (!value) return "";
  try {
    return decodeURIComponent(value).trim().slice(0, max);
  } catch {
    return "";
  }
}

async function listSongs(request: Request, env: Env): Promise<Response> {
  const viewer = await approvedUser(request, env);
  if (!viewer) return json({ error: "Нужен вход" }, 401);
  const rows = await env.DB.prepare(
    "SELECT id, title, author, created_at FROM songs ORDER BY position, created_at",
  ).all();
  return json({ songs: rows.results });
}

async function addSong(request: Request, env: Env): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user || !isCommittee(user)) return json({ error: "Нет доступа" }, 403);

  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!ALLOWED_AUDIO.includes(type)) return json({ error: "Можно загружать только аудио: mp3, m4a, wav, ogg" }, 400);

  const title = decodeHeader(request.headers.get("x-song-title"), 200);
  const author = decodeHeader(request.headers.get("x-song-author"), 200);
  if (!title) return json({ error: "Укажите название песни" }, 400);

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0) return json({ error: "Пустой файл" }, 400);
  if (bytes.byteLength > MAX_AUDIO) return json({ error: "Файл больше 20 МБ" }, 413);

  const id = randomToken(16);
  await env.FILES.put(`song:${id}`, bytes, { metadata: { contentType: type } });
  await env.DB.prepare(
    `INSERT INTO songs (id, title, author, content_type, position, uploaded_by)
     VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM songs), ?)`,
  )
    .bind(id, title, author, type, user.id)
    .run();
  return json({ ok: true, id }, 201);
}

async function getSongAudio(request: Request, env: Env, id: string): Promise<Response> {
  const viewer = await approvedUser(request, env);
  if (!viewer) return json({ error: "Нужен вход" }, 401);
  if (!/^[A-Za-z0-9_-]{10,64}$/.test(id)) return json({ error: "Не найдено" }, 404);

  const file = await env.FILES.getWithMetadata<{ contentType: string }>(`song:${id}`, "arrayBuffer");
  if (!file.value) return json({ error: "Не найдено" }, 404);
  return new Response(file.value, {
    headers: {
      "content-type": file.metadata?.contentType ?? "audio/mpeg",
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
      ...CORS,
    },
  });
}

async function deleteSong(request: Request, env: Env, id: string): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user || !isCommittee(user)) return json({ error: "Нет доступа" }, 403);
  const result = await env.DB.prepare("DELETE FROM songs WHERE id = ?").bind(id).run();
  if (result.meta?.changes === 0) return json({ error: "Песня не найдена" }, 404);
  await env.FILES.delete(`song:${id}`);
  return json({ ok: true });
}

// ---------- маршрутизация ----------

// ---------- чаты ----------
// Сообщения хранятся в D1, а доставляются в реальном времени через Ably.
// Браузер получает токен только с правом подписки на чаты, которые ему доступны.

const CHAT_MESSAGE_MAX = 2000;

interface ChatRow {
  id: number;
  kind: string;
}

interface MessageRow {
  canvas_id?: number | null;
  canvas_mode?: string | null;
  canvas_until?: string | null;
  transcript?: string | null;
  author_photo_id?: string | null;
  id: number;
  chat_id: number;
  author_id: number;
  author_name: string;
  body: string;
  attachment_id: string | null;
  attachment_name: string | null;
  attachment_kind: string | null;
  created_at: string;
  edited_at: string | null;
  deleted: number;
  reply_to_id: number | null;
  reply_author: string | null;
  reply_body: string | null;
  forwarded_from: string | null;
}

async function chatById(env: Env, id: number): Promise<ChatRow | null> {
  return await env.DB.prepare("SELECT id, kind FROM chats WHERE id = ?").bind(id).first<ChatRow>();
}

async function canAccessChat(env: Env, user: UserRow, chat: ChatRow): Promise<boolean> {
  if (chat.kind === "general") return true;
  if (chat.kind === "committee") return isCommittee(user);
  const member = await env.DB.prepare("SELECT 1 AS ok FROM chat_members WHERE chat_id = ? AND user_id = ?")
    .bind(chat.id, user.id)
    .first();
  return !!member;
}

async function accessibleChatIds(env: Env, user: UserRow): Promise<number[]> {
  const rows = await env.DB.prepare(
    `SELECT c.id FROM chats c LEFT JOIN chat_members m ON m.chat_id = c.id AND m.user_id = ?
      WHERE c.kind = 'general' OR (c.kind = 'committee' AND ? = 1) OR m.user_id IS NOT NULL`,
  )
    .bind(user.id, isCommittee(user) ? 1 : 0)
    .all<{ id: number }>();
  return rows.results.map((r) => r.id);
}

// Отправка события в канал чата. Ошибка доставки не ломает сохранение сообщения.
async function ablyPublish(env: Env, chatId: number, name: string, data: unknown): Promise<void> {
  if (!env.ABLY_API_KEY) return;
  try {
    await fetch(`https://rest.ably.io/channels/${encodeURIComponent(`chat:${chatId}`)}/messages`, {
      method: "POST",
      headers: { authorization: `Basic ${btoa(env.ABLY_API_KEY)}`, "content-type": "application/json" },
      body: JSON.stringify({ name, data: JSON.stringify(data) }),
    });
  } catch {
    // Клиенты при следующем открытии чата загрузят сообщения сами
  }
}

// Токен Ably: право подписки только на доступные этому участнику чаты (живёт час)
async function ablyToken(request: Request, env: Env): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  if (!env.ABLY_API_KEY) return json({ error: "Чаты ещё не подключены" }, 503);
  const capability: Record<string, string[]> = {};
  const chatIds = await accessibleChatIds(env, user);
  for (const id of chatIds) capability[`chat:${id}`] = ["subscribe"];
  if (chatIds.length > 0 && chatIds.length <= 90) {
    const calls = await env.DB.prepare(
      `SELECT id FROM calls WHERE ended_at IS NULL AND chat_id IN (${chatIds.map(() => "?").join(",")})`,
    )
      .bind(...chatIds)
      .all<{ id: number }>();
    for (const c of calls.results) capability[`call:${c.id}`] = ["subscribe"];
  }
  const keyName = env.ABLY_API_KEY.split(":")[0];
  const res = await fetch(`https://rest.ably.io/keys/${encodeURIComponent(keyName)}/requestToken`, {
    method: "POST",
    headers: { authorization: `Basic ${btoa(env.ABLY_API_KEY)}`, "content-type": "application/json" },
    body: JSON.stringify({ capability: JSON.stringify(capability), ttl: 3600 * 1000 }),
  });
  if (!res.ok) return json({ error: "Не удалось подключить чат" }, 502);
  return new Response(await res.text(), {
    headers: { "content-type": "application/json; charset=utf-8", ...CORS },
  });
}

async function listChats(request: Request, env: Env): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  // «Избранное» — личный чат самого пользователя: создаём, если его ещё нет
  await env.DB.prepare(
    "INSERT OR IGNORE INTO chats (kind, title, personal_key, created_by) VALUES ('favorites', 'Избранное', ?, ?)",
  )
    .bind(`fav:${user.id}`, user.id)
    .run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO chat_members (chat_id, user_id, last_read_id) SELECT id, ?, 0 FROM chats WHERE personal_key = ?",
  )
    .bind(user.id, `fav:${user.id}`)
    .run();
  // Для общего чата и чата комсостава создаём запись о членстве: в ней хранится, что прочитано.
  // Старые сообщения не считаются непрочитанными.
  await env.DB.prepare(
    `INSERT OR IGNORE INTO chat_members (chat_id, user_id, last_read_id)
     SELECT c.id, ?, COALESCE((SELECT MAX(id) FROM messages WHERE chat_id = c.id), 0)
       FROM chats c WHERE c.kind = 'general' OR (c.kind = 'committee' AND ? = 1)`,
  )
    .bind(user.id, isCommittee(user) ? 1 : 0)
    .run();

  const rows = await env.DB.prepare(
    `SELECT c.id, c.kind, c.title, c.photo_id, c.description, c.invite_mode, c.edit_mode, c.mention_mode, c.created_by,
            (SELECT p.photo_id FROM chat_members x LEFT JOIN profiles p ON p.user_id = x.user_id
              WHERE x.chat_id = c.id AND x.user_id <> ? LIMIT 1) AS other_photo,
            (SELECT body FROM messages WHERE chat_id = c.id AND deleted = 0 ORDER BY id DESC LIMIT 1) AS last_body,
            (SELECT attachment_kind FROM messages WHERE chat_id = c.id AND deleted = 0 ORDER BY id DESC LIMIT 1) AS last_kind,
            (SELECT created_at FROM messages WHERE chat_id = c.id ORDER BY id DESC LIMIT 1) AS last_at,
            (SELECT u.full_name FROM chat_members x JOIN users u ON u.id = x.user_id
              WHERE x.chat_id = c.id AND x.user_id <> ? LIMIT 1) AS other_name,
            (SELECT COUNT(*) FROM messages WHERE chat_id = c.id AND deleted = 0 AND author_id <> ?
              AND id > COALESCE(m.last_read_id, 0)) AS unread
       FROM chats c
       JOIN chat_members m ON m.chat_id = c.id AND m.user_id = ?
      ORDER BY COALESCE((SELECT created_at FROM messages WHERE chat_id = c.id ORDER BY id DESC LIMIT 1), c.created_at) DESC`,
  )
    .bind(user.id, user.id, user.id, user.id)
    .all<{
      id: number;
      kind: string;
      title: string | null;
      photo_id: string | null;
      description: string | null;
      invite_mode: string;
      edit_mode: string;
      mention_mode: string;
      created_by: number | null;
      other_photo: string | null;
      last_body: string | null;
      last_kind: string | null;
      last_at: string | null;
      other_name: string | null;
      unread: number;
    }>();

  const chats = rows.results.map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.kind === "personal" ? r.other_name ?? "Личный чат" : r.title ?? "",
    photo_id: r.kind === "personal" ? r.other_photo : r.photo_id,
    description: r.description,
    invite_mode: r.invite_mode,
    edit_mode: r.edit_mode,
    mention_mode: r.mention_mode,
    created_by: r.created_by,
    last_body: r.last_body,
    last_kind: r.last_kind,
    last_at: r.last_at,
    unread: r.unread,
  }));
  return json({ chats });
}

async function createChat(request: Request, env: Env): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const body = await readJson(request);

  if (body.kind === "personal") {
    const otherId = Number(body.user_id);
    if (!Number.isInteger(otherId) || otherId === user.id) return json({ error: "Выберите собеседника" }, 400);
    const other = await env.DB.prepare("SELECT id FROM users WHERE id = ? AND status = 'approved'")
      .bind(otherId)
      .first();
    if (!other) return json({ error: "Участник не найден" }, 404);
    const key = `${Math.min(user.id, otherId)}:${Math.max(user.id, otherId)}`;
    const existing = await env.DB.prepare("SELECT id FROM chats WHERE personal_key = ?")
      .bind(key)
      .first<{ id: number }>();
    if (existing) return json({ id: existing.id });
    const res = await env.DB.prepare("INSERT INTO chats (kind, personal_key, created_by) VALUES ('personal', ?, ?)")
      .bind(key, user.id)
      .run();
    const id = Number(res.meta.last_row_id);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?)").bind(id, user.id),
      env.DB.prepare("INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?)").bind(id, otherId),
    ]);
    return json({ id }, 201);
  }

  if (body.kind === "group") {
    const title = str(body.title, 60);
    if (!title) return json({ error: "Введите название группы" }, 400);
    const wanted = new Set<number>([user.id]);
    if (Array.isArray(body.member_ids)) {
      for (const v of body.member_ids) {
        const n = Number(v);
        if (Number.isInteger(n) && n > 0) wanted.add(n);
      }
    }
    const members: number[] = [];
    for (const id of wanted) {
      const ok = await env.DB.prepare("SELECT id FROM users WHERE id = ? AND status = 'approved'").bind(id).first();
      if (ok) members.push(id);
    }
    if (members.length < 2) return json({ error: "Добавьте хотя бы одного участника" }, 400);
    const res = await env.DB.prepare("INSERT INTO chats (kind, title, created_by) VALUES ('group', ?, ?)")
      .bind(title, user.id)
      .run();
    const id = Number(res.meta.last_row_id);
    await env.DB.batch(
      members.map((m) => env.DB.prepare("INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?)").bind(id, m)),
    );
    return json({ id }, 201);
  }

  return json({ error: "Неизвестный тип чата" }, 400);
}

function publicMessage(r: MessageRow): Record<string, unknown> {
  const deleted = !!r.deleted;
  return {
    id: r.id,
    chat_id: r.chat_id,
    author_id: r.author_id,
    author_name: r.author_name,
    author_photo_id: r.author_photo_id ?? null,
    body: deleted ? "" : r.body,
    attachment_id: deleted ? null : r.attachment_id,
    attachment_name: deleted ? null : r.attachment_name,
    attachment_kind: deleted ? null : r.attachment_kind,
    created_at: r.created_at,
    edited_at: r.edited_at,
    deleted,
    reply_to: r.reply_to_id ? { id: r.reply_to_id, author_name: r.reply_author ?? "", body: r.reply_body ?? "" } : null,
    forwarded_from: r.forwarded_from ?? null,
    transcript: deleted ? null : r.transcript ?? null,
    canvas_id: deleted ? null : r.canvas_id ?? null,
    canvas_mode: deleted ? null : r.canvas_mode ?? null,
    canvas_until: deleted ? null : r.canvas_until ?? null,
  };
}

const MESSAGE_SELECT = `SELECT m.id, m.chat_id, m.author_id, u.full_name AS author_name, m.body,
       m.attachment_id, m.attachment_name, m.attachment_kind, m.created_at, m.edited_at, m.deleted,
       m.reply_to_id, m.forwarded_from, m.transcript, m.canvas_id,
       (SELECT cv.mode FROM canvases cv WHERE cv.id = m.canvas_id) AS canvas_mode,
       (SELECT cv.edit_until FROM canvases cv WHERE cv.id = m.canvas_id) AS canvas_until,
       (SELECT p.photo_id FROM profiles p WHERE p.user_id = m.author_id) AS author_photo_id,
       (SELECT u2.full_name FROM messages x JOIN users u2 ON u2.id = x.author_id WHERE x.id = m.reply_to_id) AS reply_author,
       (SELECT CASE WHEN x.deleted = 0 THEN x.body ELSE '' END FROM messages x WHERE x.id = m.reply_to_id) AS reply_body
  FROM messages m JOIN users u ON u.id = m.author_id`;

async function listMessages(request: Request, env: Env, chatId: number, url: URL): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const chat = await chatById(env, chatId);
  if (!chat) return json({ error: "Чат не найден" }, 404);
  if (!(await canAccessChat(env, user, chat))) return json({ error: "Нет доступа" }, 403);

  const after = Number(url.searchParams.get("after") ?? 0);
  const before = Number(url.searchParams.get("before") ?? 0);
  let rows: MessageRow[];
  if (after > 0) {
    rows = (
      await env.DB.prepare(`${MESSAGE_SELECT} WHERE m.chat_id = ? AND m.id > ? AND m.deleted = 0 ORDER BY m.id ASC LIMIT 100`)
        .bind(chatId, after)
        .all<MessageRow>()
    ).results;
  } else {
    const limit = 50;
    const sql = before > 0
      ? `${MESSAGE_SELECT} WHERE m.chat_id = ? AND m.id < ? AND m.deleted = 0 ORDER BY m.id DESC LIMIT ${limit}`
      : `${MESSAGE_SELECT} WHERE m.chat_id = ? AND m.deleted = 0 ORDER BY m.id DESC LIMIT ${limit}`;
    const stmt = before > 0 ? env.DB.prepare(sql).bind(chatId, before) : env.DB.prepare(sql).bind(chatId);
    rows = (await stmt.all<MessageRow>()).results.reverse();
  }

  const reactions = await loadReactions(
    env,
    "message",
    rows.map((r) => r.id),
    user.id,
  );
  const pinned = await env.DB.prepare(
    `SELECT m.id, m.body, m.attachment_kind, u.full_name AS author_name FROM chats c
       JOIN messages m ON m.id = c.pinned_message_id AND m.deleted = 0
       JOIN users u ON u.id = m.author_id
      WHERE c.id = ?`,
  )
    .bind(chatId)
    .first<{ id: number; body: string; attachment_kind: string | null; author_name: string }>();
  return json({
    messages: rows.map((r) => ({ ...publicMessage(r), reactions: reactions.get(r.id) ?? [] })),
    pinned: pinned ?? null,
    viewer_id: user.id,
    viewer_committee: isCommittee(user),
  });
}

// Base64 без переполнения стека на длинных файлах
function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

// Расшифровка голосового через Whisper. Ошибка (например, исчерпан бесплатный лимит) не ломает отправку:
// в поле transcript остаётся пустая строка, и клиент покажет «не удалось расшифровать».
async function transcribeMessage(env: Env, messageId: number, chatId: number, attachmentId: string): Promise<void> {
  let transcript = "";
  try {
    const file = await env.FILES.getWithMetadata(`att:${attachmentId}`, "arrayBuffer");
    if (!file.value) throw new Error("Файл не найден");
    const res = (await env.AI.run("@cf/openai/whisper-large-v3-turbo", {
      audio: bytesToBase64(new Uint8Array(file.value)),
    })) as { text?: string };
    transcript = String(res.text ?? "").trim().slice(0, 4000);
  } catch (e) {
    console.error("Transcribe", e);
  }
  await env.DB.prepare("UPDATE messages SET transcript = ? WHERE id = ?").bind(transcript, messageId).run();
  await ablyPublish(env, chatId, "transcript", { id: messageId, chat_id: chatId, transcript });
}

async function sendMessage(request: Request, env: Env, chatId: number, ctx: ExecutionContext): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const chat = await chatById(env, chatId);
  if (!chat) return json({ error: "Чат не найден" }, 404);
  if (!(await canAccessChat(env, user, chat))) return json({ error: "Нет доступа" }, 403);

  const body = await readJson(request);
  const text = str(body.body, CHAT_MESSAGE_MAX);
  const attachmentId = str(body.attachment_id, 64);
  const attachmentName = str(body.attachment_name, 200) || null;
  const attachmentKind =
    body.attachment_kind === "image"
      ? "image"
      : body.attachment_kind === "audio" && attachmentId
        ? "audio"
        : body.attachment_kind === "video" && attachmentId
          ? "video"
          : body.attachment_kind === "video_note" && attachmentId
            ? "video_note"
            : attachmentId
            ? "file"
            : null;
  if (attachmentId && !/^[A-Za-z0-9_-]{10,64}$/.test(attachmentId)) return json({ error: "Неверный файл" }, 400);
  if (!text && !attachmentId) return json({ error: "Напишите сообщение или прикрепите файл" }, 400);
  const linkCanvasId = Number(body.canvas_id) || 0;
  if (linkCanvasId > 0) {
    const own = await env.DB.prepare("SELECT id FROM canvases WHERE id = ? AND chat_id = ? AND author_id = ?")
      .bind(linkCanvasId, chatId, user.id)
      .first();
    if (!own) return json({ error: "Холст не найден" }, 400);
    // Повторная отправка того же холста заменяет его прошлую картинку в чате
    if (attachmentId && attachmentKind === "image") {
      const prev = await env.DB.prepare(
        "SELECT id FROM messages WHERE chat_id = ? AND canvas_id = ? AND author_id = ? AND deleted = 0 ORDER BY id DESC LIMIT 1",
      )
        .bind(chatId, linkCanvasId, user.id)
        .first<{ id: number }>();
      if (prev) {
        await env.DB.prepare("UPDATE messages SET attachment_id = ?, attachment_name = ?, attachment_kind = 'image' WHERE id = ?")
          .bind(attachmentId, attachmentName, prev.id)
          .run();
        const replaced = await env.DB.prepare(`${MESSAGE_SELECT} WHERE m.id = ?`).bind(prev.id).first<MessageRow>();
        if (!replaced) return json({ error: "Не удалось обновить холст" }, 500);
        const updated = { ...publicMessage(replaced), reactions: [] };
        await ablyPublish(env, chatId, "message", updated);
        return json({ message: updated, replaced: true }, 200);
      }
    }
  }
  const replyId = Number(body.reply_to_id) || 0;
  if (replyId > 0) {
    const target = await env.DB.prepare("SELECT id FROM messages WHERE id = ? AND chat_id = ? AND deleted = 0")
      .bind(replyId, chatId)
      .first();
    if (!target) return json({ error: "Сообщение, на которое вы отвечаете, не найдено" }, 400);
  }

  const res = await env.DB.prepare(
    `INSERT INTO messages (chat_id, author_id, body, attachment_id, attachment_name, attachment_kind, reply_to_id, canvas_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(chatId, user.id, text, attachmentId || null, attachmentName, attachmentKind, replyId > 0 ? replyId : null, linkCanvasId > 0 ? linkCanvasId : null)
    .run();
  const messageId = Number(res.meta.last_row_id);
  const row = await env.DB.prepare(`${MESSAGE_SELECT} WHERE m.id = ?`).bind(messageId).first<MessageRow>();
  if (!row) return json({ error: "Не удалось сохранить" }, 500);
  const message = { ...publicMessage(row), reactions: [] };
  await ablyPublish(env, chatId, "message", message);
  if ((attachmentKind === "audio" || attachmentKind === "video_note") && attachmentId) {
    ctx.waitUntil(transcribeMessage(env, messageId, chatId, attachmentId));
  }
  if (await wantsMentionAll(env, chatId, user, text, chat.kind)) {
    try {
      ctx.waitUntil(notifyUsers(env, await audienceIdsExcept(env, chatId, chat.kind, user.id)));
    } catch (e) {
      console.error("Push all", e);
    }
  } else {
    try {
      await notifyChatMembers(request, env, chat, user.id);
    } catch (e) {
      console.error("Push", e);
    }
  }
  ctx.waitUntil(notifyMentioned(env, chatId, chat.kind, user, text).catch((e) => console.error("Mention", e)));
  return json({ message }, 201);
}

// @all: упоминание всех участников; "creator" в mention_mode — только управляющим
const ALL_MENTION_RE = /(^|[^\p{L}\p{N}_])@all(?![\p{L}\p{N}_])/iu;

async function wantsMentionAll(env: Env, chatId: number, author: UserRow, text: string, kind: string): Promise<boolean> {
  if (!ALL_MENTION_RE.test(text)) return false;
  const row = await env.DB.prepare("SELECT mention_mode FROM chats WHERE id = ?")
    .bind(chatId)
    .first<{ mention_mode: string }>();
  if (!row) return false;
  if (row.mention_mode !== "creator") return true;
  if (kind === "group") return await isGroupAdmin(env, chatId, author.id);
  return isCommittee(author);
}

// Кто получает уведомление о @all (и о личных упоминаниях): участники чата без автора
async function audienceIdsExcept(env: Env, chatId: number, kind: string, userId: number): Promise<number[]> {
  let rows;
  if (kind === "general") {
    rows = await env.DB.prepare("SELECT id FROM users WHERE status = 'approved' AND id <> ? LIMIT 500")
      .bind(userId)
      .all<{ id: number }>();
  } else if (kind === "committee") {
    rows = await env.DB.prepare(
      `SELECT id FROM users WHERE status = 'approved' AND role IN (${COMMITTEE.map(() => "?").join(",")}) AND id <> ? LIMIT 500`,
    )
      .bind(...COMMITTEE, userId)
      .all<{ id: number }>();
  } else {
    rows = await env.DB.prepare("SELECT user_id AS id FROM chat_members WHERE chat_id = ? AND user_id <> ? LIMIT 500")
      .bind(chatId, userId)
      .all<{ id: number }>();
  }
  return rows.results.map((r) => r.id);
}

// Личные упоминания вида @имя: уведомление только тем, кто состоит в чате
async function notifyMentioned(env: Env, chatId: number, kind: string, author: UserRow, text: string): Promise<void> {
  const names = [...text.matchAll(/(^|[^\p{L}\p{N}_])@([\p{L}\p{N}_]{3,32})/gu)]
    .map((m) => m[2].toLowerCase())
    .filter((n) => n !== "all");
  if (names.length === 0) return;
  const uniq = [...new Set(names)].slice(0, 20);
  const marks = uniq.map(() => "?").join(",");
  const rows = await env.DB.prepare(`SELECT user_id AS id FROM profiles WHERE lower(username) IN (${marks}) AND user_id <> ? LIMIT 50`)
    .bind(...uniq, author.id)
    .all<{ id: number }>();
  const allowed = new Set(await audienceIdsExcept(env, chatId, kind, author.id));
  const ids = rows.results.map((r) => r.id).filter((id) => allowed.has(id));
  if (ids.length > 0) await notifyUsers(env, ids);
}

// Медиа чата: фото, видео, файлы или ссылки из текста сообщений
async function chatMedia(request: Request, env: Env, chatId: number, url: URL): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const chat = await chatById(env, chatId);
  if (!chat) return json({ error: "Чат не найден" }, 404);
  if (!(await canAccessChat(env, user, chat))) return json({ error: "Нет доступа" }, 403);
  const kind = url.searchParams.get("kind") ?? "";
  if (kind === "link") {
    const rows = await env.DB.prepare(
      `SELECT m.id, m.body, m.created_at, u.full_name AS author_name FROM messages m
       JOIN users u ON u.id = m.author_id
       WHERE m.chat_id = ? AND m.deleted = 0 AND m.body LIKE '%http%'
       ORDER BY m.id DESC LIMIT 300`,
    )
      .bind(chatId)
      .all<{ id: number; body: string; created_at: string; author_name: string }>();
    const items: { id: number; url: string; author_name: string; created_at: string }[] = [];
    for (const r of rows.results) {
      for (const m of r.body.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
        items.push({ id: r.id, url: m[0], author_name: r.author_name, created_at: r.created_at });
      }
    }
    return json({ items: items.slice(0, 200) });
  }
  if (kind !== "image" && kind !== "video" && kind !== "file") return json({ error: "Неверный раздел" }, 400);
  // Видео в разделе «Видео» — только видеокружки; прикреплённые видеофайлы — в «Файлы»
  const kinds = kind === "video" ? ["video_note"] : kind === "file" ? ["file", "video"] : ["image"];
  const rows = await env.DB.prepare(
    `SELECT m.id, m.attachment_id, m.attachment_name, m.created_at, u.full_name AS author_name FROM messages m
     JOIN users u ON u.id = m.author_id
     WHERE m.chat_id = ? AND m.deleted = 0 AND m.attachment_kind IN (${kinds.map(() => "?").join(",")})
     ORDER BY m.id DESC LIMIT 200`,
  )
    .bind(chatId, ...kinds)
    .all();
  return json({ items: rows.results });
}

// Поиск по сообщениям чата (без учёта регистра по LIKE, спецсимволы экранируются)
async function searchMessages(request: Request, env: Env, chatId: number, url: URL): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const chat = await chatById(env, chatId);
  if (!chat) return json({ error: "Чат не найден" }, 404);
  if (!(await canAccessChat(env, user, chat))) return json({ error: "Нет доступа" }, 403);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
  if (!q) return json({ items: [] });
  const like = `%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
  const rows = await env.DB.prepare(
    `SELECT m.id, m.body, m.created_at, u.full_name AS author_name FROM messages m
     JOIN users u ON u.id = m.author_id
     WHERE m.chat_id = ? AND m.deleted = 0 AND m.body LIKE ? ESCAPE '\\'
     ORDER BY m.id DESC LIMIT 50`,
  )
    .bind(chatId, like)
    .all();
  return json({ items: rows.results });
}

async function createCanvas(request: Request, env: Env, chatId: number): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const chat = await chatById(env, chatId);
  if (!chat) return json({ error: "Чат не найден" }, 404);
  if (!(await canAccessChat(env, user, chat))) return json({ error: "Нет доступа" }, 403);
  const body = await readJson(request);
  const mode = body.mode === "personal" ? "personal" : "shared";
  const editors = body.editors === "managers" ? "managers" : body.editors === "author" ? "author" : "all";
  let editUntil: string | null = null;
  if (mode === "shared" && typeof body.edit_until === "string" && body.edit_until) {
    const t = Date.parse(body.edit_until);
    if (!isFinite(t) || t <= Date.now()) return json({ error: "Укажите срок в будущем" }, 400);
    editUntil = new Date(t).toISOString();
  }
  const created = await env.DB.prepare("INSERT INTO canvases (chat_id, author_id, mode, editors, edit_until) VALUES (?, ?, ?, ?, ?)")
    .bind(chatId, user.id, mode, mode === "personal" ? "author" : editors, editUntil)
    .run();
  return json({ canvas: { id: Number(created.meta.last_row_id), mode, editors, edit_until: editUntil } }, 201);
}

// ---------- Звонки (1 на 1 и группы до 10 участников). Сигнализация идёт через Ably, медиа — напрямую WebRTC ----------
const CALL_MAX_PARTICIPANTS = 10;

interface CallRow {
  id: number;
  chat_id: number;
  video: number;
  created_by: number;
  ended_at: string | null;
}

async function callRow(env: Env, id: number): Promise<CallRow | null> {
  return await env.DB.prepare("SELECT id, chat_id, video, created_by, ended_at FROM calls WHERE id = ?")
    .bind(id)
    .first<CallRow>();
}

// Участник считается в звонке, пока присылает heartbeat (раз в 20 секунд); иначе он «завис» после закрытия вкладки
const CALL_STALE_MS = 60_000;
function callStaleCutoff(): string {
  return new Date(Date.now() - CALL_STALE_MS).toISOString();
}

async function activeParticipants(env: Env, callId: number): Promise<{ user_id: number; full_name: string; photo_id: string | null }[]> {
  const rows = await env.DB.prepare(
    `SELECT p.user_id, u.full_name, (SELECT pr.photo_id FROM profiles pr WHERE pr.user_id = p.user_id) AS photo_id
     FROM call_participants p JOIN users u ON u.id = p.user_id
     WHERE p.call_id = ? AND p.left_at IS NULL AND p.last_seen >= ? ORDER BY p.joined_at`,
  )
    .bind(callId, callStaleCutoff())
    .all<{ user_id: number; full_name: string; photo_id: string | null }>();
  return rows.results;
}

async function ablyPublishCall(env: Env, callId: number, name: string, data: unknown): Promise<void> {
  if (!env.ABLY_API_KEY) return;
  try {
    await fetch(`https://rest.ably.io/channels/${encodeURIComponent(`call:${callId}`)}/messages`, {
      method: "POST",
      headers: { authorization: `Basic ${btoa(env.ABLY_API_KEY)}`, "content-type": "application/json" },
      body: JSON.stringify({ name, data: JSON.stringify(data) }),
    });
  } catch {
    // Участники переподключатся сами
  }
}

async function startCall(request: Request, env: Env, chatId: number): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const chat = await chatById(env, chatId);
  if (!chat) return json({ error: "Чат не найден" }, 404);
  if (!(await canAccessChat(env, user, chat))) return json({ error: "Нет доступа" }, 403);
  const body = await readJson(request);
  const video = body.video === true ? 1 : 0;
  let call = await env.DB.prepare("SELECT id, chat_id, video, created_by, ended_at FROM calls WHERE chat_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1")
    .bind(chatId)
    .first<CallRow>();
  if (call && (await activeParticipants(env, call.id)).length === 0) {
    await env.DB.prepare("UPDATE calls SET ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").bind(call.id).run();
    await ablyPublish(env, chatId, "call", { kind: "end", call_id: call.id });
    call = null;
  }
  if (!call) {
    const res = await env.DB.prepare("INSERT INTO calls (chat_id, created_by, video) VALUES (?, ?, ?)").bind(chatId, user.id, video).run();
    call = { id: Number(res.meta.last_row_id), chat_id: chatId, video, created_by: user.id, ended_at: null };
    await ablyPublish(env, chatId, "call", {
      kind: "start",
      call_id: call.id,
      chat_id: chatId,
      video: !!video,
      from_id: user.id,
      from_name: user.full_name,
    });
    try {
      await notifyChatMembers(request, env, chat, user.id);
    } catch (e) {
      console.error("Push call", e);
    }
  }
  return json({ call_id: call.id, video: !!call.video }, 201);
}

async function joinCall(request: Request, env: Env, callId: number): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const c = await callRow(env, callId);
  if (!c || c.ended_at) return json({ error: "Звонок уже завершён" }, 410);
  const chat = await chatById(env, c.chat_id);
  if (!chat || !(await canAccessChat(env, user, chat))) return json({ error: "Нет доступа" }, 403);
  const current = await activeParticipants(env, callId);
  const already = current.some((p) => p.user_id === user.id);
  if (!already && current.length >= CALL_MAX_PARTICIPANTS) {
    return json({ error: `В звонке уже ${CALL_MAX_PARTICIPANTS} участников` }, 400);
  }
  await env.DB.prepare(
    `INSERT INTO call_participants (call_id, user_id, left_at, last_seen) VALUES (?, ?, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT(call_id, user_id) DO UPDATE SET left_at = NULL, joined_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), last_seen = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  )
    .bind(callId, user.id)
    .run();
  const participants = await activeParticipants(env, callId);
  const me = participants.find((p) => p.user_id === user.id);
  if (!already) {
    await ablyPublishCall(env, callId, "member", { kind: "join", user_id: user.id, full_name: user.full_name, photo_id: me?.photo_id ?? null });
  }
  return json({ call: { id: c.id, chat_id: c.chat_id, video: !!c.video }, participants, me: user.id });
}

async function pingCall(request: Request, env: Env, callId: number): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const c = await callRow(env, callId);
  if (!c || c.ended_at) return json({ error: "Звонок уже завершён" }, 410);
  const res = await env.DB.prepare(
    "UPDATE call_participants SET last_seen = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE call_id = ? AND user_id = ? AND left_at IS NULL",
  )
    .bind(callId, user.id)
    .run();
  if (!res.meta.changes) return json({ error: "Вы не в звонке" }, 403);
  return json({ ok: true });
}

async function leaveCall(request: Request, env: Env, callId: number): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const c = await callRow(env, callId);
  if (!c) return json({ error: "Звонок не найден" }, 404);
  await env.DB.prepare(
    "UPDATE call_participants SET left_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE call_id = ? AND user_id = ? AND left_at IS NULL",
  )
    .bind(callId, user.id)
    .run();
  await ablyPublishCall(env, callId, "member", { kind: "leave", user_id: user.id });
  const left = await activeParticipants(env, callId);
  if (left.length === 0 && !c.ended_at) {
    await env.DB.prepare("UPDATE calls SET ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").bind(callId).run();
    await ablyPublish(env, c.chat_id, "call", { kind: "end", call_id: callId });
  }
  return json({ ok: true });
}

async function signalCall(request: Request, env: Env, callId: number): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const body = await readJson(request);
  const to = Number(body.to) || 0;
  const data = body.data;
  if (!to || !data || typeof data !== "object") return json({ error: "Неверный сигнал" }, 400);
  if (JSON.stringify(data).length > 20000) return json({ error: "Слишком большой сигнал" }, 400);
  const participants = await activeParticipants(env, callId);
  if (!participants.some((p) => p.user_id === user.id) || !participants.some((p) => p.user_id === to)) {
    return json({ error: "Участник не в звонке" }, 403);
  }
  await ablyPublishCall(env, callId, "signal", { from: user.id, to, data });
  return json({ ok: true });
}

async function callIce(request: Request, env: Env): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const fallback = [{ urls: ["stun:stun.l.google.com:19302"] }];
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return json({ iceServers: fallback, turn: false });
  try {
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.TURN_KEY_ID)}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ ttl: 86400 }),
      },
    );
    if (!res.ok) return json({ iceServers: fallback, turn: false });
    const data = (await res.json()) as { iceServers?: unknown };
    const list = Array.isArray(data.iceServers) ? data.iceServers : data.iceServers ? [data.iceServers] : fallback;
    return json({ iceServers: list, turn: true });
  } catch {
    return json({ iceServers: fallback, turn: false });
  }
}

const CANVAS_MAX_STROKES = 3000;
const CANVAS_MAX_POINTS = 1000;

interface CanvasRow {
  id: number;
  chat_id: number;
  author_id: number;
  mode: string;
  editors: string;
  edit_until: string | null;
}

async function canvasRow(env: Env, id: number): Promise<CanvasRow | null> {
  return await env.DB.prepare("SELECT id, chat_id, author_id, mode, editors, edit_until FROM canvases WHERE id = ?")
    .bind(id)
    .first<CanvasRow>();
}

// Кто может рисовать: личный холст — только автор; общий — по настройке editors и до срока edit_until
async function canEditCanvas(env: Env, user: UserRow, c: CanvasRow, chat: ChatRow): Promise<boolean> {
  if (c.mode === "personal") return c.author_id === user.id;
  if (c.edit_until && Date.now() > Date.parse(c.edit_until)) return false;
  if (c.author_id === user.id) return true;
  if (c.editors === "author") return false;
  if (c.editors === "managers") {
    return chat.kind === "group" ? await isGroupAdmin(env, chat.id, user.id) : isCommittee(user);
  }
  return true;
}

// История холста: штрихи по порядку, подряд идущие штрихи одного автора (с перерывом до 10 минут) — одна запись
async function canvasHistory(request: Request, env: Env, id: number): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const c = await canvasRow(env, id);
  if (!c) return json({ error: "Холст не найден" }, 404);
  const chat = await chatById(env, c.chat_id);
  if (!chat || !(await canAccessChat(env, user, chat))) return json({ error: "Нет доступа" }, 403);
  const rows = await env.DB.prepare(
    `SELECT s.id, s.author_id, s.data, s.created_at, u.full_name AS author_name,
            (SELECT p.photo_id FROM profiles p WHERE p.user_id = s.author_id) AS author_photo_id
     FROM canvas_strokes s JOIN users u ON u.id = s.author_id
     WHERE s.canvas_id = ? ORDER BY s.id LIMIT ?`,
  )
    .bind(id, CANVAS_MAX_STROKES)
    .all<{ id: number; author_id: number; data: string; created_at: string; author_name: string; author_photo_id: string | null }>();
  const groups: {
    author_id: number;
    author_name: string;
    author_photo_id: string | null;
    started_at: string;
    ended_at: string;
    strokes: { color: string; width: number; points: [number, number][] }[];
  }[] = [];
  let last: (typeof groups)[number] | null = null;
  for (const r of rows.results) {
    const stroke = JSON.parse(r.data) as { color: string; width: number; points: [number, number][] };
    const gap = last ? Date.parse(r.created_at) - Date.parse(last.ended_at) : 0;
    if (!last || last.author_id !== r.author_id || gap > 10 * 60 * 1000) {
      last = {
        author_id: r.author_id,
        author_name: r.author_name,
        author_photo_id: r.author_photo_id ?? null,
        started_at: r.created_at,
        ended_at: r.created_at,
        strokes: [],
      };
      groups.push(last);
    }
    last.ended_at = r.created_at;
    last.strokes.push({ color: stroke.color, width: stroke.width, points: stroke.points });
  }
  return json({ items: groups });
}

async function getCanvas(request: Request, env: Env, id: number): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const c = await canvasRow(env, id);
  if (!c) return json({ error: "Холст не найден" }, 404);
  const chat = await chatById(env, c.chat_id);
  if (!chat || !(await canAccessChat(env, user, chat))) return json({ error: "Нет доступа" }, 403);
  const rows = await env.DB.prepare("SELECT id, author_id, data FROM canvas_strokes WHERE canvas_id = ? ORDER BY id LIMIT ?")
    .bind(id, CANVAS_MAX_STROKES)
    .all<{ id: number; author_id: number; data: string }>();
  const strokes = rows.results.map((r) => ({ id: r.id, author_id: r.author_id, ...JSON.parse(r.data) }));
  return json({
    canvas: {
      id: c.id,
      mode: c.mode,
      author_id: c.author_id,
      can_draw: await canEditCanvas(env, user, c, chat),
      editors: c.editors,
      edit_until: c.edit_until,
      can_clear: c.author_id === user.id,
      strokes,
    },
  });
}

async function addStroke(request: Request, env: Env, id: number): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const c = await canvasRow(env, id);
  if (!c) return json({ error: "Холст не найден" }, 404);
  const chat = await chatById(env, c.chat_id);
  if (!chat || !(await canAccessChat(env, user, chat))) return json({ error: "Нет доступа" }, 403);
  if (!(await canEditCanvas(env, user, c, chat))) return json({ error: "Редактировать холст сейчас нельзя" }, 403);

  const body = await readJson(request);
  const color = typeof body.color === "string" && /^#[0-9a-fA-F]{6}$/.test(body.color) ? body.color : null;
  if (!color) return json({ error: "Неверный цвет" }, 400);
  const width = Number(body.width);
  if (!(width >= 1 && width <= 40)) return json({ error: "Неверная толщина" }, 400);
  if (!Array.isArray(body.points) || body.points.length < 1 || body.points.length > CANVAS_MAX_POINTS) {
    return json({ error: "Неверный штрих" }, 400);
  }
  const clamp = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000;
  const points: [number, number][] = [];
  for (const p of body.points as unknown[]) {
    if (!Array.isArray(p) || typeof p[0] !== "number" || typeof p[1] !== "number" || !isFinite(p[0]) || !isFinite(p[1])) {
      return json({ error: "Неверная точка" }, 400);
    }
    points.push([clamp(p[0]), clamp(p[1])]);
  }
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM canvas_strokes WHERE canvas_id = ?")
    .bind(id)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= CANVAS_MAX_STROKES) return json({ error: "Холст заполнен" }, 400);

  const data = JSON.stringify({ color, width, points });
  const res = await env.DB.prepare("INSERT INTO canvas_strokes (canvas_id, author_id, data) VALUES (?, ?, ?)")
    .bind(id, user.id, data)
    .run();
  const stroke = { id: Number(res.meta.last_row_id), author_id: user.id, color, width, points };
  await ablyPublish(env, c.chat_id, "canvas", { id, stroke });
  return json({ stroke }, 201);
}

async function clearCanvas(request: Request, env: Env, id: number): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const c = await canvasRow(env, id);
  if (!c) return json({ error: "Холст не найден" }, 404);
  if (c.author_id !== user.id) return json({ error: "Очистить холст может только автор" }, 403);
  await env.DB.prepare("DELETE FROM canvas_strokes WHERE canvas_id = ?").bind(id).run();
  await ablyPublish(env, c.chat_id, "canvas", { id, cleared: true });
  return json({ ok: true });
}

async function editMessage(request: Request, env: Env, id: number): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const row = await env.DB.prepare("SELECT author_id, chat_id, deleted FROM messages WHERE id = ?")
    .bind(id)
    .first<{ author_id: number; chat_id: number; deleted: number }>();
  if (!row) return json({ error: "Сообщение не найдено" }, 404);
  if (row.author_id !== user.id) return json({ error: "Редактировать можно только свои сообщения" }, 403);
  if (row.deleted) return json({ error: "Сообщение удалено" }, 400);
  const text = str((await readJson(request)).body, CHAT_MESSAGE_MAX);
  if (!text) return json({ error: "Текст не может быть пустым" }, 400);
  const editedAt = new Date().toISOString();
  await env.DB.prepare("UPDATE messages SET body = ?, edited_at = ? WHERE id = ?").bind(text, editedAt, id).run();
  await ablyPublish(env, row.chat_id, "edit", { id, chat_id: row.chat_id, body: text, edited_at: editedAt });
  return json({ ok: true });
}

async function deleteMessage(request: Request, env: Env, id: number): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const row = await env.DB.prepare("SELECT author_id, chat_id FROM messages WHERE id = ?")
    .bind(id)
    .first<{ author_id: number; chat_id: number }>();
  if (!row) return json({ error: "Сообщение не найдено" }, 404);
  if (row.author_id !== user.id) {
    // Комсостав может удалять чужие сообщения только в общем чате и в чате комсостава
    const chat = await chatById(env, row.chat_id);
    const moderated = chat?.kind === "general" || chat?.kind === "committee";
    if (!(isCommittee(user) && moderated)) return json({ error: "Нет доступа" }, 403);
  }
  const attachment = await env.DB.prepare("SELECT attachment_id FROM messages WHERE id = ?")
    .bind(id)
    .first<{ attachment_id: string | null }>();
  await env.DB.prepare("DELETE FROM reactions WHERE target_type = 'message' AND target_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM messages WHERE id = ?").bind(id).run();
  await env.DB.prepare("UPDATE chats SET pinned_message_id = NULL WHERE pinned_message_id = ?").bind(id).run();
  // Файл удаляем, только если его не осталось в пересланных копиях
  if (attachment?.attachment_id) {
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE attachment_id = ?")
      .bind(attachment.attachment_id)
      .first<{ n: number }>();
    if (!left || left.n === 0) await env.FILES.delete(`att:${attachment.attachment_id}`);
  }
  await ablyPublish(env, row.chat_id, "delete", { id, chat_id: row.chat_id });
  return json({ ok: true });
}

// Закрепить или открепить сообщение. В группе — кому разрешено менять информацию, в общих чатах — комсоставу
async function pinMessage(request: Request, env: Env, id: number): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const msg = await env.DB.prepare("SELECT chat_id, deleted FROM messages WHERE id = ?")
    .bind(id)
    .first<{ chat_id: number; deleted: number }>();
  if (!msg || msg.deleted) return json({ error: "Сообщение не найдено" }, 404);
  const chat = await env.DB.prepare("SELECT id, kind, created_by, edit_mode FROM chats WHERE id = ?")
    .bind(msg.chat_id)
    .first<{ id: number; kind: string; created_by: number | null; edit_mode: string }>();
  if (!chat || !(await canAccessChat(env, user, { id: chat.id, kind: chat.kind }))) return json({ error: "Нет доступа" }, 403);
  if (chat.kind === "group" && !(chat.created_by === user.id || chat.edit_mode === "all")) {
    return json({ error: "Закреплять сообщения может только создатель группы" }, 403);
  }
  if ((chat.kind === "general" || chat.kind === "committee") && !isCommittee(user)) {
    return json({ error: "Закреплять сообщения в этом чате может только комсостав" }, 403);
  }
  const body = await readJson(request);
  const pin = body.pinned !== false;
  await env.DB.prepare("UPDATE chats SET pinned_message_id = ? WHERE id = ?").bind(pin ? id : null, chat.id).run();
  await ablyPublish(env, chat.id, "pin", { chat_id: chat.id });
  return json({ ok: true });
}

// Переслать сообщение в другой чат. Вложение не копируется, а ссылается на тот же файл.
async function forwardMessage(request: Request, env: Env, id: number): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const src = await env.DB.prepare(`${MESSAGE_SELECT} WHERE m.id = ? AND m.deleted = 0`).bind(id).first<MessageRow>();
  if (!src) return json({ error: "Сообщение не найдено" }, 404);
  const srcChat = await chatById(env, src.chat_id);
  if (!srcChat || !(await canAccessChat(env, user, srcChat))) return json({ error: "Нет доступа" }, 403);
  const body = await readJson(request);
  const targetId = Number(body.chat_id);
  const target = Number.isInteger(targetId) && targetId > 0 ? await chatById(env, targetId) : null;
  if (!target) return json({ error: "Чат не найден" }, 404);
  if (!(await canAccessChat(env, user, target))) return json({ error: "Нет доступа" }, 403);
  const res = await env.DB.prepare(
    `INSERT INTO messages (chat_id, author_id, body, attachment_id, attachment_name, attachment_kind, forwarded_from)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      target.id,
      user.id,
      src.body,
      src.attachment_id,
      src.attachment_name,
      src.attachment_kind,
      src.forwarded_from ?? src.author_name,
    )
    .run();
  const row = await env.DB.prepare(`${MESSAGE_SELECT} WHERE m.id = ?`)
    .bind(Number(res.meta.last_row_id))
    .first<MessageRow>();
  if (row) await ablyPublish(env, target.id, "message", { ...publicMessage(row), reactions: [] });
  return json({ ok: true, chat_id: target.id }, 201);
}

async function markRead(request: Request, env: Env, chatId: number): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const chat = await chatById(env, chatId);
  if (!chat) return json({ error: "Чат не найден" }, 404);
  if (!(await canAccessChat(env, user, chat))) return json({ error: "Нет доступа" }, 403);
  const lastId = Number((await readJson(request)).last_id);
  if (!Number.isInteger(lastId) || lastId < 0) return json({ error: "Неверный номер сообщения" }, 400);
  await env.DB.prepare(
    `INSERT INTO chat_members (chat_id, user_id, last_read_id) VALUES (?, ?, ?)
     ON CONFLICT (chat_id, user_id) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)`,
  )
    .bind(chatId, user.id, lastId)
    .run();
  return json({ ok: true });
}

// Фото чата: в групповом чате может менять любой участник, в общих чатах — только комсостав
async function setChatPhoto(request: Request, env: Env, chatId: number): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const chat = await chatById(env, chatId);
  if (!chat) return json({ error: "Чат не найден" }, 404);
  if (chat.kind === "personal" || chat.kind === "favorites") return json({ error: "У этого чата нет своего фото" }, 400);
  if (!(await canAccessChat(env, user, chat))) return json({ error: "Нет доступа" }, 403);
  if ((chat.kind === "general" || chat.kind === "committee") && !isCommittee(user)) {
    return json({ error: "Фото этого чата меняет комсостав" }, 403);
  }
  const photoId = str((await readJson(request)).photo_id, 64);
  if (photoId && !/^[A-Za-z0-9_-]{10,64}$/.test(photoId)) return json({ error: "Неверное фото" }, 400);
  await env.DB.prepare("UPDATE chats SET photo_id = ? WHERE id = ?").bind(photoId || null, chatId).run();
  return json({ ok: true });
}

// Участники чата: в группах и личных — кто в чате, в общих чатах — все участники отряда (или комсостав)
// Админ группы: её создатель или участник, которого он назначил админом
async function isGroupAdmin(env: Env, chatId: number, userId: number): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS ok FROM chats c
      WHERE c.id = ? AND c.kind = 'group'
        AND (c.created_by = ? OR EXISTS (SELECT 1 FROM chat_members m WHERE m.chat_id = c.id AND m.user_id = ? AND m.is_admin = 1))`,
  )
    .bind(chatId, userId, userId)
    .first();
  return !!row;
}

async function isGroupMember(env: Env, chatId: number, userId: number): Promise<boolean> {
  const row = await env.DB.prepare("SELECT 1 AS ok FROM chat_members WHERE chat_id = ? AND user_id = ?").bind(chatId, userId).first();
  return !!row;
}

// Участники группы, где пользователь админ: для постановки задач участникам чата
async function listAdminChats(request: Request, env: Env): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const chats = (
    await env.DB.prepare(
      `SELECT c.id, c.title FROM chats c
        WHERE c.kind = 'group' AND (c.created_by = ? OR EXISTS (SELECT 1 FROM chat_members m WHERE m.chat_id = c.id AND m.user_id = ? AND m.is_admin = 1))
        ORDER BY c.title`,
    )
      .bind(user.id, user.id)
      .all<{ id: number; title: string }>()
  ).results;
  const out = [];
  for (const c of chats) {
    const members = (
      await env.DB.prepare(
        `SELECT u.id, u.full_name FROM chat_members m JOIN users u ON u.id = m.user_id
          WHERE m.chat_id = ? AND u.status = 'approved' AND u.id != ? ORDER BY u.full_name`,
      )
        .bind(c.id, user.id)
        .all()
    ).results;
    out.push({ id: c.id, title: c.title, members });
  }
  return json({ chats: out });
}

// Назначить или снять админа группы: только создатель группы
async function setChatAdmin(request: Request, env: Env, chatId: number, targetId: number): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const chat = await env.DB.prepare("SELECT id, kind, created_by FROM chats WHERE id = ?")
    .bind(chatId)
    .first<{ id: number; kind: string; created_by: number | null }>();
  if (!chat || chat.kind !== "group") return json({ error: "Админов назначают только в группе" }, 400);
  if (chat.created_by !== user.id) return json({ error: "Админов назначает создатель группы" }, 403);
  if (targetId === user.id) return json({ error: "Создатель и так админ" }, 400);
  if (!(await isGroupMember(env, chatId, targetId))) return json({ error: "Участник не в группе" }, 400);
  const body = await readJson(request);
  await env.DB.prepare("UPDATE chat_members SET is_admin = ? WHERE chat_id = ? AND user_id = ?")
    .bind(body.admin === true ? 1 : 0, chatId, targetId)
    .run();
  return json({ ok: true });
}

async function listChatMembers(request: Request, env: Env, chatId: number): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const chat = await chatById(env, chatId);
  if (!chat) return json({ error: "Чат не найден" }, 404);
  if (!(await canAccessChat(env, user, chat))) return json({ error: "Нет доступа" }, 403);
  const base = `SELECT u.id, u.full_name, u.role, p.photo_id FROM users u LEFT JOIN profiles p ON p.user_id = u.id`;
  let rows;
  if (chat.kind === "general") {
    rows = await env.DB.prepare(`${base} WHERE u.status = 'approved' ORDER BY u.full_name`).all();
  } else if (chat.kind === "committee") {
    rows = await env.DB.prepare(
      `${base} WHERE u.status = 'approved' AND u.role IN ('master', 'commissar', 'commander') ORDER BY u.full_name`,
    ).all();
  } else {
    rows = await env.DB.prepare(
      `${base} JOIN chat_members m ON m.user_id = u.id WHERE m.chat_id = ? AND u.status = 'approved' ORDER BY u.full_name`,
    )
      .bind(chatId)
      .all();
  }
  const adminIds = new Set<number>();
  const creatorRow = await env.DB.prepare("SELECT created_by FROM chats WHERE id = ?").bind(chatId).first<{ created_by: number | null }>();
  const creatorId = creatorRow?.created_by ?? null;
  if (chat.kind === "group") {
    const flags = (await env.DB.prepare("SELECT user_id FROM chat_members WHERE chat_id = ? AND is_admin = 1").bind(chatId).all<{ user_id: number }>()).results;
    for (const f of flags) adminIds.add(f.user_id);
    if (creatorId !== null) adminIds.add(creatorId);
  }
  const members = rows.results.map((m: Record<string, unknown>) => ({
    ...m,
    is_admin: adminIds.has(Number(m.id)) ? 1 : 0,
    is_creator: creatorId === Number(m.id) ? 1 : 0,
  }));
  return json({ members, viewer_id: user.id });
}

// Добавить людей в групповой чат: добавлять может любой участник группы
async function addChatMembers(request: Request, env: Env, chatId: number): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const chat = await env.DB.prepare("SELECT id, kind, created_by, invite_mode FROM chats WHERE id = ?")
    .bind(chatId)
    .first<{ id: number; kind: string; created_by: number | null; invite_mode: string }>();
  if (!chat || chat.kind !== "group") return json({ error: "Добавлять можно только в группу" }, 400);
  if (!(await canAccessChat(env, user, { id: chat.id, kind: chat.kind }))) return json({ error: "Нет доступа" }, 403);
  if (chat.invite_mode === "creator" && chat.created_by !== user.id) {
    return json({ error: "Приглашать участников может только создатель группы" }, 403);
  }
  const body = await readJson(request);
  const ids = Array.isArray(body.user_ids) ? body.user_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
  for (const id of new Set(ids)) {
    const ok = await env.DB.prepare("SELECT id FROM users WHERE id = ? AND status = 'approved'").bind(id).first();
    if (ok) {
      await env.DB.prepare("INSERT OR IGNORE INTO chat_members (chat_id, user_id) VALUES (?, ?)").bind(chatId, id).run();
    }
  }
  return json({ ok: true });
}

// Выйти из группы (личные и общие чаты покинуть нельзя)
async function leaveChat(request: Request, env: Env, chatId: number): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const chat = await chatById(env, chatId);
  if (!chat || chat.kind !== "group") return json({ error: "Из этого чата нельзя выйти" }, 400);
  await env.DB.prepare("DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?").bind(chatId, user.id).run();
  return json({ ok: true });
}


// ---------- задачи ----------

const TASK_TITLE_MAX = 200;
const TASK_DESC_MAX = 4000;
const TASK_COMMENT_MAX = 1000;
const TASK_SUBTASK_MAX = 200;
const TASK_REMINDERS_MAX = 10;
const TASK_LIMIT = 500;
const REMIND_BATCH = 20; // напоминаний за одну минуту (бережём лимит подзапросов Workers)
const API_ORIGIN = "https://white-nights-api.white-nights.workers.dev";

interface TaskRow {
  id: number;
  title: string;
  color: string | null;
  description: string;
  due_date: string | null;
  importance: number;
  creator_id: number;
  creator_name: string;
  assignee_id: number;
  assignee_name: string;
  assigned_by_committee: number;
  assigned_by_admin: number;
  attachment_id: string | null;
  attachment_name: string | null;
  status: string;
  done_at: string | null;
  created_at: string;
  edited_at: string | null;
  comments_count: number;
  reminders_raw: string | null;
  for_all: number;
  done_count: number;
  members_total: number;
  viewers_json: string | null;
  needs_confirm: number;
  confirm_condition: string | null;
}

interface SubtaskRow {
  id: number;
  task_id?: number;
  title: string;
  done: number;
  importance: number;
  assignee_id: number | null;
  assignee_name: string | null;
}

// Подпункт может получить исполнителя только из тех, кто видит задачу
function cleanAssignee(task: TaskRow, raw: unknown): number | null | "bad" {
  if (raw === undefined || raw === null || raw === "") return null;
  const uid = Number(raw);
  if (!Number.isInteger(uid) || uid <= 0) return "bad";
  const allowed = uid === task.creator_id || uid === task.assignee_id || parseViewers(task.viewers_json).some((v) => v.user_id === uid);
  return allowed ? uid : "bad";
}

const TASK_SELECT = `SELECT t.id, t.title, t.description, t.due_date, t.importance, t.creator_id, cu.full_name AS creator_name,
  t.assignee_id, au.full_name AS assignee_name, t.assigned_by_committee, t.assigned_by_admin, t.attachment_id, t.attachment_name,
  t.for_all, t.needs_confirm, t.confirm_condition, t.color,
  CASE WHEN t.for_all = 1 THEN (CASE WHEN EXISTS (SELECT 1 FROM task_done d WHERE d.task_id = t.id AND d.user_id = ?) THEN 'done' ELSE 'open' END) ELSE t.status END AS status,
  CASE WHEN t.for_all = 1 THEN (SELECT d.done_at FROM task_done d WHERE d.task_id = t.id AND d.user_id = ?) ELSE t.done_at END AS done_at,
  t.created_at, t.edited_at,
  (SELECT COUNT(*) FROM task_comments c WHERE c.task_id = t.id) AS comments_count,
  (SELECT COUNT(*) FROM task_done d WHERE d.task_id = t.id) AS done_count,
  (SELECT COUNT(*) FROM users WHERE status = 'approved') AS members_total,
  (SELECT group_concat(r.remind_at, '|') FROM task_reminders r WHERE r.task_id = t.id) AS reminders_raw,
  (SELECT json_group_array(json_object('user_id', a.user_id, 'can_edit', a.can_edit, 'is_executor', a.is_executor, 'name', vu.full_name))
     FROM task_access a JOIN users vu ON vu.id = a.user_id WHERE a.task_id = t.id) AS viewers_json
  FROM tasks t JOIN users cu ON cu.id = t.creator_id JOIN users au ON au.id = t.assignee_id`;

// Задачу видят: её создатель и исполнитель, а также весь комсостав — если задачу назначил комсостав
function canSeeTask(user: UserRow, t: TaskAccessFields): boolean {
  if (t.for_all === 1) return true;
  return (
    t.creator_id === user.id ||
    t.assignee_id === user.id ||
    (isCommittee(user) && t.assigned_by_committee === 1) ||
    viewerAccess(user, t) !== null
  );
}

interface TaskAccessFields {
  creator_id: number;
  assignee_id: number;
  assigned_by_committee: number;
  assigned_by_admin?: number;
  for_all?: number;
  viewers_json?: string | null;
  needs_confirm?: number;
}

// Исполнители — видящие, отмеченные как исполнитель (если никого нет — исполнитель создатель/назначенный)
function executorCount(t: { viewers_json?: string | null }): number {
  return parseViewers(t.viewers_json).filter((v) => v.is_executor === 1).length;
}

function isExecutorOf(user: UserRow, t: TaskAccessFields): boolean {
  return t.assignee_id === user.id || parseViewers(t.viewers_json).some((v) => v.user_id === user.id && v.is_executor === 1);
}

// Выполнение нужно подтвердить: комсостав поставил задачу, стоит галочка или исполнителей несколько
function requiresConfirm(t: TaskAccessFields): boolean {
  return t.needs_confirm === 1 || t.assigned_by_committee === 1 || t.assigned_by_admin === 1 || executorCount(t) > 1;
}

// Подтверждает выполнение: при нескольких исполнителях — только создатель, иначе — комсостав
function canConfirm(user: UserRow, t: TaskAccessFields & { creator_id: number }): boolean {
  // Задачу, которую поставил админ чата, подтверждает сам админ
  if (t.assigned_by_admin === 1) return t.creator_id === user.id;
  if (executorCount(t) > 1) return t.creator_id === user.id;
  return (t.assigned_by_committee === 1 || t.needs_confirm === 1) && isCommittee(user);
}

interface ViewerItem {
  user_id: number;
  can_edit: number;
  is_executor?: number;
  name?: string;
}

function parseViewers(raw: string | null | undefined): ViewerItem[] {
  if (!raw) return [];
  try {
    return JSON.parse(raw) as ViewerItem[];
  } catch {
    return [];
  }
}

// null — задача не выделена пользователю; 1 — может редактировать; 0 — только видит
function viewerAccess(user: UserRow, t: { viewers_json?: string | null }): number | null {
  const found = parseViewers(t.viewers_json).find((v) => v.user_id === user.id);
  return found ? found.can_edit : null;
}

// Менять подпункты и закрывать задачу могут только создатель и исполнитель
// Выполненную задачу нельзя редактировать: обычную — когда отмечена, у «Весь отряд» — когда выполнили все
function isLocked(t: TaskRow): boolean {
  if (t.for_all === 1) return t.members_total > 0 && t.done_count >= t.members_total;
  return t.status === "done";
}

// Создатель, исполнитель и видящие с правом редактирования
function isTaskParty(user: UserRow, t: TaskAccessFields & { creator_id: number }): boolean {
  return t.creator_id === user.id || isExecutorOf(user, t) || viewerAccess(user, t) === 1;
}

async function taskById(env: Env, id: number, viewerId: number): Promise<TaskRow | null> {
  return env.DB.prepare(`${TASK_SELECT} WHERE t.id = ?`).bind(viewerId, viewerId, id).first<TaskRow>();
}

function shapeTask(row: TaskRow, subtasks: SubtaskRow[]) {
  const { reminders_raw, viewers_json, ...rest } = row;
  const reminders = reminders_raw ? reminders_raw.split("|").sort() : [];
  return {
    ...rest,
    reminders,
    viewers: parseViewers(viewers_json).map((v) => ({ user_id: v.user_id, can_edit: v.can_edit, is_executor: v.is_executor ?? 0, name: v.name ?? "" })),
    subtasks: subtasks.map((s) => ({
      id: s.id,
      title: s.title,
      done: s.done,
      importance: s.importance ?? 3,
      assignee_id: s.assignee_id ?? null,
      assignee_name: s.assignee_name ?? null,
    })),
  };
}

async function loadTaskOut(env: Env, id: number, viewerId: number) {
  const row = await taskById(env, id, viewerId);
  if (!row) return null;
  const subs = (
    await env.DB.prepare(
      `SELECT s.id, s.title, s.done, s.importance, s.assignee_id, u.full_name AS assignee_name
         FROM task_subtasks s LEFT JOIN users u ON u.id = s.assignee_id
        WHERE s.task_id = ? ORDER BY s.importance DESC, s.position, s.id`,
    )
      .bind(id)
      .all<SubtaskRow>()
  ).results;
  return shapeTask(row, subs);
}

function cleanDate(value: unknown): string | null {
  const s = str(value, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// Самая ранняя допустимая дата срока: вчера по UTC (небольшой запас на часовой пояс)
function minDueDate(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// Время напоминания приходит как ISO-строка с часовым поясом и хранится в UTC
function cleanRemind(value: unknown): string | null {
  const s = str(value, 40);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

// Список напоминаний из запроса: уникальные моменты времени, отсортированные
function parseReminders(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  const list = raw
    .slice(0, TASK_REMINDERS_MAX)
    .map((v) => cleanRemind(v))
    .filter((v): v is string => v !== null);
  return [...new Set(list)].sort();
}

function cleanImportance(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : fallback;
}

// Проверяет, что вложение загружено; возвращает его имя или null
async function attachmentName(env: Env, id: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{10,64}$/.test(id)) return null;
  const att = await env.FILES.getWithMetadata<{ uploadedBy: number; name: string }>(`att:${id}`);
  if (!att.value) return null;
  return att.metadata?.name ?? "file";
}

// Пуш-уведомления пользователям (текст не передаётся, в браузере показывается общий заголовок)
async function notifyUsers(env: Env, userIds: number[]): Promise<void> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || userIds.length === 0) return;
  const marks = userIds.map(() => "?").join(",");
  const rows = (
    await env.DB.prepare(`SELECT id, endpoint FROM push_subscriptions WHERE user_id IN (${marks}) LIMIT ?`)
      .bind(...userIds, PUSH_MAX_SENDS)
      .all<{ id: number; endpoint: string }>()
  ).results;
  await Promise.allSettled(rows.map((r) => sendPush(env, r, API_ORIGIN)));
}

// Вызывается по расписанию: шлёт напоминания, у которых подошло время
async function notifyAllApproved(env: Env, exceptId: number): Promise<void> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return;
  const rows = (
    await env.DB.prepare(
      "SELECT s.id, s.endpoint FROM push_subscriptions s JOIN users u ON u.id = s.user_id WHERE u.status = 'approved' AND s.user_id <> ? LIMIT ?",
    )
      .bind(exceptId, PUSH_MAX_SENDS)
      .all<{ id: number; endpoint: string }>()
  ).results;
  await Promise.allSettled(rows.map((r) => sendPush(env, r, API_ORIGIN)));
}

// Вызывается по расписанию: шлёт напоминания, у которых подошло время
async function sendDueReminders(env: Env): Promise<void> {
  const due = (
    await env.DB.prepare(
      `SELECT r.id, t.assignee_id, t.status, t.for_all FROM task_reminders r JOIN tasks t ON t.id = r.task_id
       WHERE r.sent = 0 AND r.remind_at <= ? ORDER BY r.remind_at LIMIT ?`,
    )
      .bind(new Date().toISOString(), REMIND_BATCH)
      .all<{ id: number; assignee_id: number; status: string; for_all: number }>()
  ).results;
  let allSent = false;
  for (const r of due) {
    // Рассылка всему отряду занимает много запросов: одну такую за минуту, остальное в следующую
    if (r.for_all === 1) {
      if (allSent) break;
      allSent = true;
    }
    // Сначала отмечаем, чтобы при сбое напоминание не ушло дважды
    await env.DB.prepare("UPDATE task_reminders SET sent = 1 WHERE id = ?").bind(r.id).run();
    if (r.for_all === 1) await notifyAllApproved(env, 0);
    else if (r.status === "open") await notifyUsers(env, [r.assignee_id]);
  }
}

// Заменяет напоминания задачи. Новые моменты не должны быть в прошлом; уже существующие не трогаем.
type HistoryChange = { f: string; from: string | null; to: string | null };

// Запись в историю и отметка «Редактировано»
async function recordHistory(env: Env, taskId: number, userId: number, changes: HistoryChange[]): Promise<void> {
  if (changes.length === 0) return;
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO task_history (task_id, user_id, changes, created_at) VALUES (?, ?, ?, ?)")
    .bind(taskId, userId, JSON.stringify(changes), now)
    .run();
  await env.DB.prepare("UPDATE tasks SET edited_at = ? WHERE id = ?").bind(now, taskId).run();
}

async function userName(env: Env, id: number): Promise<string> {
  const u = await env.DB.prepare("SELECT full_name FROM users WHERE id = ?").bind(id).first<{ full_name: string }>();
  return u?.full_name ?? "";
}

// Проверяет новые напоминания: прошлое время для уже существующих не считаем новым
async function checkNewReminders(env: Env, taskId: number, list: string[]): Promise<string | null> {
  const known = new Set(
    (await env.DB.prepare("SELECT remind_at FROM task_reminders WHERE task_id = ?").bind(taskId).all<{ remind_at: string }>())
      .results.map((r) => r.remind_at),
  );
  const now = new Date().toISOString();
  return list.some((iso) => !known.has(iso) && iso <= now) ? "Напоминание не может быть в прошлом" : null;
}

// Заменяет напоминания задачи (проверку делает вызывающий код до записи)
async function replaceReminders(env: Env, taskId: number, list: string[]): Promise<void> {
  const existing = (
    await env.DB.prepare("SELECT id, remind_at FROM task_reminders WHERE task_id = ?")
      .bind(taskId)
      .all<{ id: number; remind_at: string }>()
  ).results;
  const known = new Set(existing.map((e) => e.remind_at));
  for (const e of existing) {
    if (!list.includes(e.remind_at)) await env.DB.prepare("DELETE FROM task_reminders WHERE id = ?").bind(e.id).run();
  }
  for (const iso of list) {
    if (!known.has(iso)) await env.DB.prepare("INSERT INTO task_reminders (task_id, remind_at) VALUES (?, ?)").bind(taskId, iso).run();
  }
}

// ---- Доски в стиле Trello: у каждого участника своя доска, свои колонки, карточки — задачи
type BoardRow = { id: number; title: string; color: string; creator_id: number };

const BOARD_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_BOARD_COLOR = "#4a8ef0";
function boardColor(raw: unknown): string | null {
  return typeof raw === "string" && BOARD_COLOR_RE.test(raw) ? raw : null;
}

async function boardAccess(env: Env, boardId: number, user: UserRow) {
  const board = await env.DB.prepare("SELECT id, title, color, creator_id FROM boards WHERE id = ?").bind(boardId).first<BoardRow>();
  if (!board) return { error: json({ error: "Доска не найдена" }, 404) } as const;
  const isCreator = board.creator_id === user.id;
  const m = await env.DB.prepare("SELECT can_edit FROM board_members WHERE board_id = ? AND user_id = ?")
    .bind(boardId, user.id)
    .first<{ can_edit: number }>();
  if (!isCreator && !m) return { error: json({ error: "Нет доступа к доске" }, 403) } as const;
  return { board, isCreator, canEdit: isCreator || (m?.can_edit ?? 0) === 1 } as const;
}

async function setBoardMembers(env: Env, boardId: number, creatorId: number, raw: unknown): Promise<void> {
  if (!Array.isArray(raw)) return;
  const stmts = [env.DB.prepare("DELETE FROM board_members WHERE board_id = ?").bind(boardId)];
  const seen = new Set<number>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const m = item as { user_id?: unknown; can_edit?: unknown };
    const uid = Number(m.user_id);
    if (!Number.isInteger(uid) || uid <= 0 || uid === creatorId || seen.has(uid)) continue;
    seen.add(uid);
    const canEdit = m.can_edit === true || m.can_edit === 1 ? 1 : 0;
    stmts.push(env.DB.prepare("INSERT INTO board_members (board_id, user_id, can_edit) VALUES (?, ?, ?)").bind(boardId, uid, canEdit));
  }
  await env.DB.batch(stmts);
}

async function listBoards(request: Request, env: Env): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const boards = (
    await env.DB.prepare(
      `SELECT b.id, b.title, b.color, b.creator_id, u.full_name AS creator_name,
              (SELECT COUNT(*) FROM board_cards c WHERE c.board_id = b.id) AS cards_count,
              (CASE WHEN b.creator_id = ? THEN 1
                    WHEN EXISTS (SELECT 1 FROM board_members m WHERE m.board_id = b.id AND m.user_id = ? AND m.can_edit = 1) THEN 1
                    ELSE 0 END) AS can_edit
         FROM boards b JOIN users u ON u.id = b.creator_id
        WHERE b.creator_id = ? OR EXISTS (SELECT 1 FROM board_members m WHERE m.board_id = b.id AND m.user_id = ?)
        ORDER BY b.id DESC`,
    )
      .bind(user.id, user.id, user.id, user.id)
      .all<{ id: number; title: string; color: string; creator_id: number; creator_name: string; cards_count: number; can_edit: number }>()
  ).results;
  if (boards.length === 0) return json({ boards: [] });
  const marks = boards.map(() => "?").join(",");
  const ids = boards.map((b) => b.id);
  const cols = (
    await env.DB.prepare(`SELECT id, board_id, title, color FROM board_columns WHERE board_id IN (${marks}) ORDER BY position, id`)
      .bind(...ids)
      .all<{ id: number; board_id: number; title: string; color: string | null }>()
  ).results;
  const cards = (
    await env.DB.prepare(`SELECT board_id, column_id, task_id, color FROM board_cards WHERE board_id IN (${marks}) ORDER BY position, task_id`)
      .bind(...ids)
      .all<{ board_id: number; column_id: number; task_id: number; color: string | null }>()
  ).results;
  return json({
    boards: boards.map((b) => ({
      ...b,
      columns: cols
        .filter((c) => c.board_id === b.id)
        .map((c) => ({
          id: c.id,
          title: c.title,
          color: c.color,
          cards: cards.filter((k) => k.column_id === c.id).map((k) => ({ task_id: k.task_id, color: k.color })),
        })),
    })),
  });
}

async function createBoard(request: Request, env: Env): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const body = await readJson(request);
  const title = str(body.title, 120);
  if (!title) return json({ error: "Укажите название доски" }, 400);
  const color = boardColor(body.color) ?? DEFAULT_BOARD_COLOR;
  const res = await env.DB.prepare("INSERT INTO boards (title, creator_id, color) VALUES (?, ?, ?)").bind(title, user.id, color).run();
  const id = Number(res.meta.last_row_id);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO board_columns (board_id, title, position) VALUES (?, ?, 0)").bind(id, "К выполнению"),
    env.DB.prepare("INSERT INTO board_columns (board_id, title, position) VALUES (?, ?, 1)").bind(id, "В работе"),
  ]);
  await setBoardMembers(env, id, user.id, body.members);
  return json({ board: { id, title, color } }, 201);
}

async function getBoard(request: Request, env: Env, boardId: number): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const acc = await boardAccess(env, boardId, user);
  if ("error" in acc) return acc.error;
  const cols = (
    await env.DB.prepare("SELECT id, title, position, color FROM board_columns WHERE board_id = ? ORDER BY position, id")
      .bind(boardId)
      .all<{ id: number; title: string; position: number; color: string | null }>()
  ).results;
  const cards = (
    await env.DB.prepare("SELECT task_id, column_id, color FROM board_cards WHERE board_id = ? ORDER BY position, task_id")
      .bind(boardId)
      .all<{ task_id: number; column_id: number; color: string | null }>()
  ).results;
  const taskCache = new Map<number, Awaited<ReturnType<typeof loadTaskOut>>>();
  for (const c of cards) {
    if (!taskCache.has(c.task_id)) taskCache.set(c.task_id, await loadTaskOut(env, c.task_id, user.id));
  }
  const columns = cols.map((col) => ({
    id: col.id,
    title: col.title,
    color: col.color,
    cards: cards
      .filter((c) => c.column_id === col.id)
      .map((c) => {
        const t = taskCache.get(c.task_id);
        return t ? { ...t, card_color: c.color } : null;
      })
      .filter((t) => t !== null),
  }));
  const members = (
    await env.DB.prepare(
      "SELECT m.user_id, u.full_name, m.can_edit FROM board_members m JOIN users u ON u.id = m.user_id WHERE m.board_id = ? ORDER BY u.full_name",
    )
      .bind(boardId)
      .all()
  ).results;
  return json({
    board: { id: boardId, title: acc.board.title, color: acc.board.color, creator_id: acc.board.creator_id, is_creator: acc.isCreator, can_edit: acc.canEdit },
    columns,
    members,
  });
}

async function updateBoard(request: Request, env: Env, boardId: number): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const acc = await boardAccess(env, boardId, user);
  if ("error" in acc) return acc.error;
  const body = await readJson(request);
  if (body.title !== undefined) {
    if (!acc.canEdit) return json({ error: "Нет прав менять доску" }, 403);
    const title = str(body.title, 120);
    if (!title) return json({ error: "Укажите название доски" }, 400);
    await env.DB.prepare("UPDATE boards SET title = ? WHERE id = ?").bind(title, boardId).run();
  }
  if (body.color !== undefined) {
    if (!acc.canEdit) return json({ error: "Нет прав менять доску" }, 403);
    const color = boardColor(body.color);
    if (!color) return json({ error: "Неверный цвет" }, 400);
    await env.DB.prepare("UPDATE boards SET color = ? WHERE id = ?").bind(color, boardId).run();
  }
  if (body.members !== undefined) {
    if (!acc.isCreator) return json({ error: "Участников доски меняет её создатель" }, 403);
    await setBoardMembers(env, boardId, acc.board.creator_id, body.members);
  }
  return json({ ok: true });
}

async function deleteBoard(request: Request, env: Env, boardId: number): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const acc = await boardAccess(env, boardId, user);
  if ("error" in acc) return acc.error;
  if (!acc.isCreator) return json({ error: "Удалить доску может только её создатель" }, 403);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM board_cards WHERE board_id = ?").bind(boardId),
    env.DB.prepare("DELETE FROM board_columns WHERE board_id = ?").bind(boardId),
    env.DB.prepare("DELETE FROM board_members WHERE board_id = ?").bind(boardId),
    env.DB.prepare("DELETE FROM boards WHERE id = ?").bind(boardId),
  ]);
  return json({ ok: true });
}

async function createBoardColumn(request: Request, env: Env, boardId: number): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const acc = await boardAccess(env, boardId, user);
  if ("error" in acc) return acc.error;
  if (!acc.canEdit) return json({ error: "Нет прав менять доску" }, 403);
  const body = await readJson(request);
  const title = str(body.title, 60);
  if (!title) return json({ error: "Укажите название колонки" }, 400);
  const pos = await env.DB.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM board_columns WHERE board_id = ?")
    .bind(boardId)
    .first<{ p: number }>();
  const res = await env.DB.prepare("INSERT INTO board_columns (board_id, title, position) VALUES (?, ?, ?)")
    .bind(boardId, title, pos?.p ?? 0)
    .run();
  return json({ column: { id: Number(res.meta.last_row_id), title } }, 201);
}

async function updateBoardColumn(request: Request, env: Env, boardId: number, colId: number): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const acc = await boardAccess(env, boardId, user);
  if ("error" in acc) return acc.error;
  if (!acc.canEdit) return json({ error: "Нет прав менять доску" }, 403);
  const body = await readJson(request);
  if (body.title !== undefined) {
    const title = str(body.title, 60);
    if (!title) return json({ error: "Укажите название колонки" }, 400);
    await env.DB.prepare("UPDATE board_columns SET title = ? WHERE id = ? AND board_id = ?").bind(title, colId, boardId).run();
  }
  if (body.color !== undefined) {
    // null — вернуть цвет доски
    let color: string | null = null;
    if (body.color !== null) {
      color = boardColor(body.color);
      if (!color) return json({ error: "Неверный цвет" }, 400);
    }
    await env.DB.prepare("UPDATE board_columns SET color = ? WHERE id = ? AND board_id = ?").bind(color, colId, boardId).run();
  }
  return json({ ok: true });
}

async function deleteBoardColumn(request: Request, env: Env, boardId: number, colId: number): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const acc = await boardAccess(env, boardId, user);
  if ("error" in acc) return acc.error;
  if (!acc.canEdit) return json({ error: "Нет прав менять доску" }, 403);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM board_cards WHERE board_id = ? AND column_id = ?").bind(boardId, colId),
    env.DB.prepare("DELETE FROM board_columns WHERE id = ? AND board_id = ?").bind(colId, boardId),
  ]);
  return json({ ok: true });
}

// Порядок карточек во всех колонках сразу: { columns: [{ column_id, task_ids: [...] }] }
async function saveBoardOrder(request: Request, env: Env, boardId: number): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const acc = await boardAccess(env, boardId, user);
  if ("error" in acc) return acc.error;
  if (!acc.canEdit) return json({ error: "Нет прав менять доску" }, 403);
  const body = await readJson(request);
  if (!Array.isArray(body.columns)) return json({ error: "Неверный формат" }, 400);
  const colIds = new Set(
    (await env.DB.prepare("SELECT id FROM board_columns WHERE board_id = ?").bind(boardId).all<{ id: number }>()).results.map((r) => r.id),
  );
  const stmts: D1PreparedStatement[] = [];
  for (const item of body.columns as { column_id?: unknown; task_ids?: unknown }[]) {
    const colId = Number(item.column_id);
    if (!colIds.has(colId) || !Array.isArray(item.task_ids)) continue;
    item.task_ids.forEach((raw, idx) => {
      const taskId = Number(raw);
      if (!Number.isInteger(taskId)) return;
      stmts.push(
        env.DB.prepare("UPDATE board_cards SET column_id = ?, position = ? WHERE board_id = ? AND task_id = ?").bind(colId, idx, boardId, taskId),
      );
    });
  }
  if (stmts.length) await env.DB.batch(stmts);
  return json({ ok: true });
}

async function addBoardCard(request: Request, env: Env, boardId: number): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const acc = await boardAccess(env, boardId, user);
  if ("error" in acc) return acc.error;
  if (!acc.canEdit) return json({ error: "Нет прав менять доску" }, 403);
  const body = await readJson(request);
  const taskId = Number(body.task_id);
  const colId = Number(body.column_id);
  const col = await env.DB.prepare("SELECT id FROM board_columns WHERE id = ? AND board_id = ?").bind(colId, boardId).first();
  if (!col) return json({ error: "Колонка не найдена" }, 404);
  const task = await loadTaskOut(env, taskId, user.id);
  if (!task) return json({ error: "Задача не найдена" }, 404);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO board_cards (board_id, task_id, column_id, position)
     VALUES (?, ?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM board_cards WHERE column_id = ?))`,
  )
    .bind(boardId, taskId, colId, colId)
    .run();
  return json({ ok: true }, 201);
}

// Цвет карточки на конкретной доске; null — вернуть цвет доски
async function updateBoardCard(request: Request, env: Env, boardId: number, taskId: number): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const acc = await boardAccess(env, boardId, user);
  if ("error" in acc) return acc.error;
  if (!acc.canEdit) return json({ error: "Нет прав менять доску" }, 403);
  const body = await readJson(request);
  let color: string | null = null;
  if (body.color !== null && body.color !== undefined) {
    color = boardColor(body.color);
    if (!color) return json({ error: "Неверный цвет" }, 400);
  }
  await env.DB.prepare("UPDATE board_cards SET color = ? WHERE board_id = ? AND task_id = ?").bind(color, boardId, taskId).run();
  return json({ ok: true });
}

async function removeBoardCard(request: Request, env: Env, boardId: number, taskId: number): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const acc = await boardAccess(env, boardId, user);
  if ("error" in acc) return acc.error;
  if (!acc.canEdit) return json({ error: "Нет прав менять доску" }, 403);
  await env.DB.prepare("DELETE FROM board_cards WHERE board_id = ? AND task_id = ?").bind(boardId, taskId).run();
  return json({ ok: true });
}

async function listTasks(request: Request, env: Env): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const rows = (
    await env.DB.prepare(
      `${TASK_SELECT} WHERE t.creator_id = ? OR t.assignee_id = ? OR t.for_all = 1 OR (? = 1 AND t.assigned_by_committee = 1)
         OR EXISTS (SELECT 1 FROM task_access a WHERE a.task_id = t.id AND a.user_id = ?)
       ORDER BY ((t.for_all = 1 AND EXISTS (SELECT 1 FROM task_done d WHERE d.task_id = t.id AND d.user_id = ?)) OR (t.for_all = 0 AND t.status = 'done')),
         (t.due_date IS NULL), t.due_date, t.importance DESC, t.id DESC LIMIT ?`,
    )
      .bind(user.id, user.id, user.id, user.id, isCommittee(user) ? 1 : 0, user.id, user.id, TASK_LIMIT)
      .all<TaskRow>()
  ).results;
  const subs = (
    await env.DB.prepare(
      `SELECT s.id, s.task_id, s.title, s.done, s.importance, s.assignee_id, u.full_name AS assignee_name
         FROM task_subtasks s LEFT JOIN users u ON u.id = s.assignee_id
        ORDER BY s.importance DESC, s.position, s.id`,
    ).all<SubtaskRow>()
  ).results;
  const byTask = new Map<number, SubtaskRow[]>();
  for (const s of subs) byTask.set(s.task_id ?? 0, [...(byTask.get(s.task_id ?? 0) ?? []), s]);
  return json({ tasks: rows.map((r) => shapeTask(r, byTask.get(r.id) ?? [])), me: user.id });
}

// Счётчик для значка в меню: открытые задачи, которые ждут самого пользователя
async function taskBadge(request: Request, env: Env): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS open FROM tasks t WHERE (t.for_all = 0 AND t.assignee_id = ? AND t.status = 'open')
       OR (t.for_all = 1 AND NOT EXISTS (SELECT 1 FROM task_done d WHERE d.task_id = t.id AND d.user_id = ?))`,
  )
    .bind(user.id, user.id)
    .first<{ open: number }>();
  return json({ open: row?.open ?? 0 });
}

// Список видящих: только одобренные пользователи, без создателя
async function cleanViewers(
  env: Env,
  raw: unknown,
  skip: number[],
): Promise<{ user_id: number; can_edit: number; is_executor: number }[] | string> {
  if (!Array.isArray(raw)) return "Неверный список видящих";
  const picked = new Map<number, { can_edit: number; is_executor: number }>();
  for (const item of raw.slice(0, 200)) {
    const v = item as { user_id?: unknown; can_edit?: unknown; is_executor?: unknown } | null;
    const uid = Number(v?.user_id);
    if (!Number.isInteger(uid) || uid <= 0) return "Неверный список видящих";
    if (skip.includes(uid)) continue;
    picked.set(uid, { can_edit: v?.can_edit === true ? 1 : 0, is_executor: v?.is_executor === true ? 1 : 0 });
  }
  for (const uid of picked.keys()) {
    const ok = await env.DB.prepare("SELECT id FROM users WHERE id = ? AND status = 'approved'").bind(uid).first();
    if (!ok) return "Пользователь не найден";
  }
  return [...picked].map(([user_id, f]) => ({ user_id, ...f }));
}

async function replaceViewers(
  env: Env,
  taskId: number,
  list: { user_id: number; can_edit: number; is_executor: number }[],
): Promise<void> {
  await env.DB.prepare("DELETE FROM task_access WHERE task_id = ?").bind(taskId).run();
  for (const v of list) {
    await env.DB.prepare("INSERT INTO task_access (task_id, user_id, can_edit, is_executor) VALUES (?, ?, ?, ?)")
      .bind(taskId, v.user_id, v.can_edit, v.is_executor)
      .run();
  }
}

// Уведомляет тех, кто должен подтвердить выполнение
async function notifyConfirmers(env: Env, t: TaskAccessFields & { creator_id: number }, exceptId: number): Promise<void> {
  if (executorCount(t) > 1) {
    if (t.creator_id !== exceptId) await notifyUsers(env, [t.creator_id]);
    return;
  }
  const ids = (
    await env.DB.prepare(
      `SELECT id FROM users WHERE status = 'approved' AND role IN (${COMMITTEE.map(() => "?").join(",")}) AND id <> ?`,
    )
      .bind(...COMMITTEE, exceptId)
      .all<{ id: number }>()
  ).results.map((r) => r.id);
  if (ids.length) await notifyUsers(env, ids);
}

// Все подпункты выполнены — задача выполняется сама; снят хотя бы один — открывается снова
async function syncSubtaskStatus(env: Env, taskId: number): Promise<void> {
  const c = await env.DB.prepare("SELECT COUNT(*) AS total, COALESCE(SUM(done), 0) AS done FROM task_subtasks WHERE task_id = ?")
    .bind(taskId)
    .first<{ total: number; done: number }>();
  if (!c || c.total === 0) return;
  const t = await taskById(env, taskId, 0);
  if (!t || t.for_all === 1) return;
  let next: string;
  if (c.done !== c.total) {
    if (t.status === "open") return;
    next = "open";
  } else {
    next = requiresConfirm(t) ? "waiting" : "done";
  }
  if (t.status === next) return;
  await env.DB.prepare("UPDATE tasks SET status = ?, done_at = ? WHERE id = ?")
    .bind(next, next === "done" ? new Date().toISOString() : null, taskId)
    .run();
  if (next === "waiting") await notifyConfirmers(env, t, 0);
}

async function createTask(request: Request, env: Env): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const body = await readJson(request);
  const title = str(body.title, TASK_TITLE_MAX);
  if (!title) return json({ error: "Укажите название задачи" }, 400);
  const forAll = body.assignee_id === "all";
  if (forAll && !isCommittee(user)) return json({ error: "Задачу всему отряду ставит комсостав" }, 403);
  let assigneeId = forAll || body.assignee_id === undefined ? user.id : Number(body.assignee_id);
  if (!Number.isInteger(assigneeId) || assigneeId <= 0) return json({ error: "Неверный исполнитель" }, 400);
  // Другим участникам задачу ставит комсостав или админ группы, в которой состоит исполнитель
  const chatIdRaw = body.chat_id === undefined || body.chat_id === null ? null : Number(body.chat_id);
  let byAdmin = false;
  if (!forAll && assigneeId !== user.id && !isCommittee(user)) {
    const allowed =
      chatIdRaw !== null &&
      Number.isInteger(chatIdRaw) &&
      (await isGroupAdmin(env, chatIdRaw, user.id)) &&
      (await isGroupMember(env, chatIdRaw, assigneeId));
    if (!allowed) return json({ error: "Задачи другим назначает комсостав или админ чата" }, 403);
    byAdmin = true;
  }
  const assignee = await env.DB.prepare("SELECT id FROM users WHERE id = ? AND status = 'approved'")
    .bind(assigneeId)
    .first<{ id: number }>();
  if (!assignee) return json({ error: "Исполнитель не найден" }, 400);

  const dueDate = cleanDate(body.due_date);
  if (dueDate && dueDate < minDueDate()) return json({ error: "Срок не может быть в прошлом" }, 400);
  const reminders = parseReminders(body.reminders);
  if (!reminders) return json({ error: "Неверный формат напоминаний" }, 400);
  const now = new Date().toISOString();
  if (reminders.some((iso) => iso <= now)) return json({ error: "Напоминание не может быть в прошлом" }, 400);

  const attachmentId = str(body.attachment_id, 64) || null;
  let attName: string | null = null;
  if (attachmentId) {
    attName = await attachmentName(env, attachmentId);
    if (!attName) return json({ error: "Файл не найден" }, 400);
  }
  let viewers = body.viewers === undefined ? [] : await cleanViewers(env, body.viewers, [user.id]);
  if (typeof viewers === "string") return json({ error: viewers }, 400);
  if (forAll) viewers = viewers.map((v) => ({ ...v, is_executor: 0 }));
  const execs = viewers.filter((v) => v.is_executor === 1);
  if (!forAll && execs.length) {
    if (!isCommittee(user)) return json({ error: "Задачи другим назначает комсостав" }, 403);
    assigneeId = execs[0].user_id;
  }
  const needsConfirm = isCommittee(user) && body.needs_confirm === true ? 1 : 0;
  const confirmCondition = needsConfirm ? str(body.confirm_condition, 500) || null : null;
  const assignedByCommittee = isCommittee(user) && (forAll || assigneeId !== user.id) ? 1 : 0;
  const result = await env.DB.prepare(
    `INSERT INTO tasks (title, description, due_date, importance, creator_id, assignee_id, assigned_by_committee,
       attachment_id, attachment_name, for_all, needs_confirm, confirm_condition, assigned_by_admin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      title,
      str(body.description, TASK_DESC_MAX),
      dueDate,
      cleanImportance(body.importance, 3),
      user.id,
      assigneeId,
      assignedByCommittee,
      attachmentId,
      attName,
      forAll ? 1 : 0,
      needsConfirm,
      confirmCondition,
      byAdmin ? 1 : 0,
    )
    .run();
  const id = Number(result.meta.last_row_id);
  await replaceReminders(env, id, reminders);
  await replaceViewers(env, id, viewers);
  // Подпункты, заданные сразу при создании
  const subtaskTitles: string[] = [];
  if (Array.isArray(body.subtasks)) {
    for (const item of body.subtasks.slice(0, 50)) {
      const title = str(item, TASK_SUBTASK_MAX);
      if (title) subtaskTitles.push(title);
    }
  }
  for (let i = 0; i < subtaskTitles.length; i++) {
    await env.DB.prepare("INSERT INTO task_subtasks (task_id, title, position) VALUES (?, ?, ?)")
      .bind(id, subtaskTitles[i], i + 1)
      .run();
  }
  if (forAll) await notifyAllApproved(env, user.id);
  else {
    const notify = [...new Set([...viewers.map((v) => v.user_id), ...(assigneeId !== user.id ? [assigneeId] : [])])];
    if (notify.length) await notifyUsers(env, notify);
  }
  return json({ task: await loadTaskOut(env, id, user.id) }, 201);
}

// Создатель меняет всё, исполнитель — только напоминания
async function updateTask(request: Request, env: Env, id: number): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const task = await taskById(env, id, user.id);
  if (!task || !canSeeTask(user, task)) return json({ error: "Не найдено" }, 404);
  const isCreator = task.creator_id === user.id;
  // Создатель и видящие с правом редактирования меняют всё, исполнитель — только напоминания
  const canEdit = isCreator || viewerAccess(user, task) === 1;
  if (!canEdit && task.assignee_id !== user.id) return json({ error: "Нет доступа" }, 403);
  if (isLocked(task)) return json({ error: "Выполненную задачу нельзя редактировать" }, 403);
  const body = await readJson(request);

  let title = task.title;
  let description = task.description;
  let dueDate = task.due_date;
  let importance = task.importance;
  let assigneeId = task.assignee_id;
  let attachmentId = task.attachment_id;
  let attachmentLabel = task.attachment_name;
  if (canEdit) {
    if (body.title !== undefined) {
      title = str(body.title, TASK_TITLE_MAX);
      if (!title) return json({ error: "Укажите название задачи" }, 400);
    }
    if (body.description !== undefined) description = str(body.description, TASK_DESC_MAX);
    if (body.due_date !== undefined) {
      dueDate = cleanDate(body.due_date);
      // Прошлый срок не ставим, но старую задачу с уже прошедшим сроком можно править
      if (dueDate && dueDate !== task.due_date && dueDate < minDueDate()) {
        return json({ error: "Срок не может быть в прошлом" }, 400);
      }
    }
    if (body.importance !== undefined) importance = cleanImportance(body.importance, importance);
    if (body.assignee_id !== undefined) {
      const wantAll = body.assignee_id === "all";
      if (wantAll !== (task.for_all === 1)) return json({ error: "Тип исполнителя менять нельзя" }, 400);
      const nid = Number(body.assignee_id);
      if (!wantAll && nid !== task.assignee_id) {
        if (!isCommittee(user)) return json({ error: "Задачи другим назначает комсостав" }, 403);
        const exists = await env.DB.prepare("SELECT id FROM users WHERE id = ? AND status = 'approved'").bind(nid).first();
        if (!Number.isInteger(nid) || nid <= 0 || !exists) return json({ error: "Исполнитель не найден" }, 400);
        assigneeId = nid;
      }
    }
    if (body.attachment_id !== undefined) {
      attachmentId = str(body.attachment_id, 64) || null;
      attachmentLabel = null;
      if (attachmentId) {
        attachmentLabel = await attachmentName(env, attachmentId);
        if (!attachmentLabel) return json({ error: "Файл не найден" }, 400);
      }
    }
  }
  // Видящих может менять только создатель
  let newViewers: { user_id: number; can_edit: number; is_executor: number }[] | null = null;
  if (isCreator && body.viewers !== undefined) {
    const cleaned = await cleanViewers(env, body.viewers, [task.creator_id]);
    if (typeof cleaned === "string") return json({ error: cleaned }, 400);
    newViewers = task.for_all === 1 ? cleaned.map((v) => ({ ...v, is_executor: 0 })) : cleaned;
    const execs = newViewers.filter((v) => v.is_executor === 1);
    if (task.for_all !== 1) {
      if (execs.length && !isCommittee(user)) return json({ error: "Задачи другим назначает комсостав" }, 403);
      assigneeId = execs.length ? execs[0].user_id : task.creator_id;
    }
  }
  let needsConfirm = task.needs_confirm;
  let confirmCondition = task.confirm_condition;
  if (isCommittee(user) && body.needs_confirm !== undefined) needsConfirm = body.needs_confirm === true ? 1 : 0;
  if (isCommittee(user) && body.confirm_condition !== undefined) confirmCondition = str(body.confirm_condition, 500) || null;
  if (!needsConfirm) confirmCondition = null;
  // Новые напоминания проверяем до записи, чтобы при ошибке ничего не менялось
  let reminderList: string[] | null = null;
  if (body.reminders !== undefined) {
    reminderList = parseReminders(body.reminders);
    if (!reminderList) return json({ error: "Неверный формат напоминаний" }, 400);
    const err = await checkNewReminders(env, id, reminderList);
    if (err) return json({ error: err }, 400);
  }

  const changes: HistoryChange[] = [];
  if (title !== task.title) changes.push({ f: "title", from: task.title, to: title });
  if (description !== task.description) changes.push({ f: "description", from: task.description, to: description });
  if (dueDate !== task.due_date) changes.push({ f: "due_date", from: task.due_date, to: dueDate });
  if (importance !== task.importance) changes.push({ f: "importance", from: String(task.importance), to: String(importance) });
  if (assigneeId !== task.assignee_id) changes.push({ f: "assignee", from: task.assignee_name, to: await userName(env, assigneeId) });
  if (attachmentId !== task.attachment_id) changes.push({ f: "attachment", from: task.attachment_name, to: attachmentLabel });
  const oldViewers = parseViewers(task.viewers_json);
  if (newViewers) {
    const describe = (list: { user_id: number; can_edit: number; name?: string }[]) =>
      list.length ? list.map((v) => `${v.name ?? ""}${v.can_edit ? " (ред.)" : ""}`).join(", ") : null;
    const before = describe(oldViewers);
    const after = describe(await Promise.all(newViewers.map(async (v) => ({ ...v, name: await userName(env, v.user_id) }))));
    if (before !== after) changes.push({ f: "viewers", from: before, to: after });
  }

  const assignedByCommittee = isCommittee(user) && (task.for_all === 1 || assigneeId !== user.id) ? 1 : 0;
  await env.DB.prepare(
    `UPDATE tasks SET title = ?, description = ?, due_date = ?, importance = ?, assignee_id = ?,
       assigned_by_committee = ?, attachment_id = ?, attachment_name = ?, needs_confirm = ?, confirm_condition = ?
     WHERE id = ?`,
  )
    .bind(title, description, dueDate, importance, assigneeId, assignedByCommittee, attachmentId, attachmentLabel, needsConfirm, confirmCondition, id)
    .run();

  if (newViewers) {
    await replaceViewers(env, id, newViewers);
    const oldIds = oldViewers.map((v) => v.user_id);
    const added = newViewers.map((v) => v.user_id).filter((uid) => !oldIds.includes(uid));
    if (added.length) await notifyUsers(env, added);
  }

  if (reminderList) {
    const oldRem = (
      await env.DB.prepare("SELECT remind_at FROM task_reminders WHERE task_id = ?").bind(id).all<{ remind_at: string }>()
    ).results.map((r) => r.remind_at);
    for (const iso of reminderList) if (!oldRem.includes(iso)) changes.push({ f: "reminder_add", from: null, to: iso });
    for (const iso of oldRem) if (!reminderList.includes(iso)) changes.push({ f: "reminder_remove", from: iso, to: null });
    await replaceReminders(env, id, reminderList);
  }
  await recordHistory(env, id, user.id, changes);
  if (assigneeId !== task.assignee_id) await notifyUsers(env, [assigneeId]);
  return json({ task: await loadTaskOut(env, id, user.id) });
}

async function listTaskHistory(request: Request, env: Env, id: number): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const task = await taskById(env, id, user.id);
  if (!task || !canSeeTask(user, task)) return json({ error: "Не найдено" }, 404);
  const rows = (
    await env.DB.prepare(
      `SELECT h.id, h.changes, h.created_at, u.full_name AS user_name FROM task_history h
       JOIN users u ON u.id = h.user_id WHERE h.task_id = ? ORDER BY h.id DESC LIMIT 200`,
    )
      .bind(id)
      .all<{ id: number; changes: string; created_at: string; user_name: string }>()
  ).results;
  return json({
    history: rows.map((r) => ({ id: r.id, created_at: r.created_at, user_name: r.user_name, changes: JSON.parse(r.changes) as HistoryChange[] })),
  });
}

// Перенос задачи на другой день (срок меняется у всех, кто видит задачу)
async function setTaskDue(request: Request, env: Env, id: number): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const task = await taskById(env, id, user.id);
  if (!task || !canSeeTask(user, task)) return json({ error: "Не найдено" }, 404);
  if (!isTaskParty(user, task)) return json({ error: "Нет доступа" }, 403);
  if (task.status === "done") return json({ error: "Выполненную задачу нельзя переносить" }, 400);
  const body = await readJson(request);
  const due = cleanDate(body.due_date);
  if (!due) return json({ error: "Неверная дата" }, 400);
  if (due < minDueDate()) return json({ error: "Срок не может быть в прошлом" }, 400);
  await env.DB.prepare("UPDATE tasks SET due_date = ? WHERE id = ?").bind(due, id).run();
  return json({ ok: true });
}

// Цвет задачи в списке; null — без цвета. Меняют те, кто участвует в задаче
async function setTaskColor(request: Request, env: Env, id: number): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const task = await taskById(env, id, user.id);
  if (!task || !canSeeTask(user, task)) return json({ error: "Не найдено" }, 404);
  if (!isTaskParty(user, task)) return json({ error: "Нет доступа" }, 403);
  const body = await readJson(request);
  let color: string | null = null;
  if (body.color !== null && body.color !== undefined) {
    color = boardColor(body.color);
    if (!color) return json({ error: "Неверный цвет" }, 400);
  }
  await env.DB.prepare("UPDATE tasks SET color = ? WHERE id = ?").bind(color, id).run();
  return json({ ok: true });
}

async function setTaskStatus(request: Request, env: Env, id: number): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const task = await taskById(env, id, user.id);
  if (!task || !canSeeTask(user, task)) return json({ error: "Не найдено" }, 404);
  const body = await readJson(request);
  const done = body.done === true;
  if (task.for_all === 1) {
    // Задача всему отряду: отметка только для самого пользователя
    if (done) {
      await env.DB.prepare("INSERT OR REPLACE INTO task_done (task_id, user_id, done_at) VALUES (?, ?, ?)")
        .bind(id, user.id, new Date().toISOString())
        .run();
    } else {
      await env.DB.prepare("DELETE FROM task_done WHERE task_id = ? AND user_id = ?").bind(id, user.id).run();
    }
    return json({ task: await loadTaskOut(env, id, user.id) });
  }
  const confirmer = canConfirm(user, task);
  const needs = requiresConfirm(task);
  let next: string;
  if (!done) {
    if (!isTaskParty(user, task) && !confirmer) return json({ error: "Нет доступа" }, 403);
    next = "open";
  } else if (confirmer) {
    next = "done";
  } else if (isExecutorOf(user, task)) {
    next = needs ? "waiting" : "done";
  } else if (task.creator_id === user.id && !needs) {
    next = "done";
  } else {
    return json({ error: "Отметить выполнение может исполнитель, а подтвердить — проверяющий" }, 403);
  }
  await env.DB.prepare("UPDATE tasks SET status = ?, done_at = ? WHERE id = ?")
    .bind(next, next === "done" ? new Date().toISOString() : null, id)
    .run();
  if (next === "waiting" && task.status !== "waiting") await notifyConfirmers(env, task, user.id);
  // Задача, которую назначил комсостав, выполнена — уведомляем весь комсостав
  if (next === "done" && task.status !== "done" && task.assigned_by_committee === 1) {
    const committeeIds = (
      await env.DB.prepare(
        `SELECT id FROM users WHERE status = 'approved' AND role IN (${COMMITTEE.map(() => "?").join(",")}) AND id <> ?`,
      )
        .bind(...COMMITTEE, user.id)
        .all<{ id: number }>()
    ).results.map((r) => r.id);
    await notifyUsers(env, committeeIds);
  }
  return json({ task: await loadTaskOut(env, id, user.id) });
}

async function deleteTask(request: Request, env: Env, id: number): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const task = await taskById(env, id, user.id);
  if (!task || !canSeeTask(user, task)) return json({ error: "Не найдено" }, 404);
  if (task.creator_id !== user.id) return json({ error: "Удалить задачу может её создатель" }, 403);
  await env.DB.prepare("DELETE FROM task_reminders WHERE task_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM task_subtasks WHERE task_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM task_comments WHERE task_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM task_history WHERE task_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM task_done WHERE task_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM tasks WHERE id = ?").bind(id).run();
  if (task.attachment_id) await env.FILES.delete(`att:${task.attachment_id}`);
  return json({ ok: true });
}

async function listTaskComments(request: Request, env: Env, id: number): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const task = await taskById(env, id, user.id);
  if (!task || !canSeeTask(user, task)) return json({ error: "Не найдено" }, 404);
  const rows = (
    await env.DB.prepare(
      `SELECT c.id, c.body, c.created_at, c.author_id, u.full_name AS author_name
       FROM task_comments c JOIN users u ON u.id = c.author_id WHERE c.task_id = ? ORDER BY c.id LIMIT 300`,
    )
      .bind(id)
      .all()
  ).results;
  return json({ comments: rows });
}

async function addTaskComment(request: Request, env: Env, id: number): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const task = await taskById(env, id, user.id);
  if (!task || !canSeeTask(user, task)) return json({ error: "Не найдено" }, 404);
  const body = await readJson(request);
  const text = str(body.body, TASK_COMMENT_MAX);
  if (!text) return json({ error: "Напишите комментарий" }, 400);
  await env.DB.prepare("INSERT INTO task_comments (task_id, author_id, body) VALUES (?, ?, ?)")
    .bind(id, user.id, text)
    .run();
  // Уведомляем другую сторону: если пишет исполнитель — создателя, и наоборот
  const other = user.id === task.creator_id ? task.assignee_id : task.creator_id;
  if (other !== user.id) await notifyUsers(env, [other]);
  return json({ ok: true }, 201);
}

// Подпункты: добавлять, отмечать и удалять могут создатель и исполнитель
async function addSubtask(request: Request, env: Env, taskId: number): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const task = await taskById(env, taskId, user.id);
  if (!task || !canSeeTask(user, task) || !isTaskParty(user, task)) return json({ error: "Не найдено" }, 404);
  if (isLocked(task)) return json({ error: "Выполненную задачу нельзя редактировать" }, 403);
  const body = await readJson(request);
  const title = str(body.title, TASK_SUBTASK_MAX);
  if (!title) return json({ error: "Напишите пункт" }, 400);
  const assigneeId = cleanAssignee(task, body.assignee_id);
  if (assigneeId === "bad") return json({ error: "Исполнитель пункта — из тех, кто добавлен в задачу" }, 400);
  await env.DB.prepare(
    "INSERT INTO task_subtasks (task_id, title, position, importance, assignee_id) VALUES (?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM task_subtasks WHERE task_id = ?), ?, ?)",
  )
    .bind(taskId, title, taskId, cleanImportance(body.importance, 3), assigneeId)
    .run();
  if (assigneeId && assigneeId !== user.id) await notifyUsers(env, [assigneeId]);
  await syncSubtaskStatus(env, taskId);
  await recordHistory(env, taskId, user.id, [{ f: "subtask_add", from: null, to: title }]);
  return json({ task: await loadTaskOut(env, taskId, user.id) }, 201);
}

async function subtaskParent(
  env: Env,
  user: UserRow,
  subId: number,
  forDone = false,
): Promise<{ taskId: number; task: TaskRow; assigneeId: number | null } | null> {
  const sub = await env.DB.prepare("SELECT task_id, assignee_id FROM task_subtasks WHERE id = ?")
    .bind(subId)
    .first<{ task_id: number; assignee_id: number | null }>();
  if (!sub) return null;
  const task = await taskById(env, sub.task_id, user.id);
  if (!task || !canSeeTask(user, task)) return null;
  // Отметить пункт может и его исполнитель, даже если он не исполняет задачу
  if (!isTaskParty(user, task) && !(forDone && sub.assignee_id === user.id)) return null;
  return { taskId: sub.task_id, task, assigneeId: sub.assignee_id };
}

async function updateSubtask(request: Request, env: Env, subId: number): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const body = await readJson(request);
  const onlyDone = body.done !== undefined && body.title === undefined && body.importance === undefined && body.assignee_id === undefined;
  const parent = await subtaskParent(env, user, subId, onlyDone);
  if (!parent) return json({ error: "Не найдено" }, 404);
  if (isLocked(parent.task)) return json({ error: "Выполненную задачу нельзя редактировать" }, 403);
  if (body.title !== undefined) {
    const title = str(body.title, TASK_SUBTASK_MAX);
    if (!title) return json({ error: "Напишите пункт" }, 400);
    const prev = await env.DB.prepare("SELECT title FROM task_subtasks WHERE id = ?").bind(subId).first<{ title: string }>();
    await env.DB.prepare("UPDATE task_subtasks SET title = ? WHERE id = ?").bind(title, subId).run();
    if (prev && prev.title !== title) {
      await recordHistory(env, parent.taskId, user.id, [{ f: "subtask_rename", from: prev.title, to: title }]);
    }
  }
  if (body.importance !== undefined) {
    await env.DB.prepare("UPDATE task_subtasks SET importance = ? WHERE id = ?").bind(cleanImportance(body.importance, 3), subId).run();
  }
  if (body.assignee_id !== undefined) {
    const assigneeId = cleanAssignee(parent.task, body.assignee_id);
    if (assigneeId === "bad") return json({ error: "Исполнитель пункта — из тех, кто добавлен в задачу" }, 400);
    await env.DB.prepare("UPDATE task_subtasks SET assignee_id = ? WHERE id = ?").bind(assigneeId, subId).run();
    if (assigneeId && assigneeId !== parent.assigneeId && assigneeId !== user.id) await notifyUsers(env, [assigneeId]);
  }
  if (body.done !== undefined) {
    await env.DB.prepare("UPDATE task_subtasks SET done = ? WHERE id = ?").bind(body.done === true ? 1 : 0, subId).run();
    await syncSubtaskStatus(env, parent.taskId);
  }
  return json({ task: await loadTaskOut(env, parent.taskId, user.id) });
}

async function deleteSubtask(request: Request, env: Env, subId: number): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const parent = await subtaskParent(env, user, subId);
  if (!parent) return json({ error: "Не найдено" }, 404);
  if (isLocked(parent.task)) return json({ error: "Выполненную задачу нельзя редактировать" }, 403);
  const prev = await env.DB.prepare("SELECT title FROM task_subtasks WHERE id = ?").bind(subId).first<{ title: string }>();
  await env.DB.prepare("DELETE FROM task_subtasks WHERE id = ?").bind(subId).run();
  await syncSubtaskStatus(env, parent.taskId);
  if (prev) await recordHistory(env, parent.taskId, user.id, [{ f: "subtask_remove", from: prev.title, to: null }]);
  return json({ task: await loadTaskOut(env, parent.taskId, user.id) });
}

// ---- Push-уведомления (Web Push с ключами VAPID). Текст сообщения в push не передаётся. ----
const PUSH_MAX_SENDS = 45; // Workers разрешает ограниченное число подзапросов на один запрос

function b64urlToBytes(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

function bytesToB64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Заголовок Authorization для push-сервиса браузера (JWT, подписанный ключом VAPID)
async function vapidAuthorization(env: Env, endpoint: string, origin: string): Promise<string | null> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return null;
  const pub = b64urlToBytes(env.VAPID_PUBLIC_KEY);
  const key = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      d: env.VAPID_PRIVATE_KEY,
      x: bytesToB64url(pub.slice(1, 33)),
      y: bytesToB64url(pub.slice(33, 65)),
      ext: true,
    },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const enc = new TextEncoder();
  const head = bytesToB64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = bytesToB64url(
    enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: origin })),
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${head}.${body}`)),
  );
  return `vapid t=${head}.${body}.${bytesToB64url(sig)}, k=${env.VAPID_PUBLIC_KEY}`;
}

async function sendPush(env: Env, sub: { id: number; endpoint: string }, origin: string): Promise<void> {
  const auth = await vapidAuthorization(env, sub.endpoint, origin);
  if (!auth) return;
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: { TTL: "86400", Urgency: "normal", Authorization: auth, "Content-Length": "0" },
  });
  // Подписка устарела (браузер её отозвал) — удаляем
  if (res.status === 404 || res.status === 410) {
    await env.DB.prepare("DELETE FROM push_subscriptions WHERE id = ?").bind(sub.id).run();
  }
}

// Уведомляем участников чата, кроме автора. Тех, кому чат недоступен, не трогаем.
async function notifyChatMembers(request: Request, env: Env, chat: ChatRow, authorId: number): Promise<void> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return;
  const cols = "SELECT s.id, s.endpoint FROM push_subscriptions s JOIN users u ON u.id = s.user_id";
  let stmt;
  if (chat.kind === "general") {
    stmt = env.DB.prepare(`${cols} WHERE u.status = 'approved' AND s.user_id <> ? LIMIT ?`).bind(authorId, PUSH_MAX_SENDS);
  } else if (chat.kind === "committee") {
    stmt = env.DB.prepare(
      `${cols} WHERE u.status = 'approved' AND u.role IN (${COMMITTEE.map(() => "?").join(",")}) AND s.user_id <> ? LIMIT ?`,
    ).bind(...COMMITTEE, authorId, PUSH_MAX_SENDS);
  } else {
    stmt = env.DB.prepare(
      `${cols} JOIN chat_members m ON m.user_id = s.user_id WHERE m.chat_id = ? AND s.user_id <> ? LIMIT ?`,
    ).bind(chat.id, authorId, PUSH_MAX_SENDS);
  }
  const rows = (await stmt.all<{ id: number; endpoint: string }>()).results;
  const origin = new URL(request.url).origin;
  await Promise.allSettled(rows.map((r) => sendPush(env, r, origin)));
}

async function pushKey(env: Env): Promise<Response> {
  return json({ key: env.VAPID_PUBLIC_KEY ?? null });
}

async function savePushSubscription(request: Request, env: Env): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const body = await readJson(request);
  const endpoint = str(body.endpoint, 2000);
  const keys = (body.keys ?? {}) as Record<string, unknown>;
  const p256dh = str(keys.p256dh, 200);
  const auth = str(keys.auth, 200);
  if (!endpoint.startsWith("https://") || !p256dh || !auth) return json({ error: "Неверная подписка" }, 400);
  await env.DB.prepare(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
  )
    .bind(user.id, endpoint, p256dh, auth)
    .run();
  return json({ ok: true }, 201);
}

async function removePushSubscription(request: Request, env: Env): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const body = await readJson(request);
  await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?")
    .bind(str(body.endpoint, 2000), user.id)
    .run();
  return json({ ok: true });
}

// Настройки чата. В группе название и описание меняет тот, кому разрешено (создатель или все участники),
// а права приглашения и редактирования задаёт только создатель. В общих чатах меняет комсостав.
async function updateChatSettings(request: Request, env: Env, chatId: number): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const chat = await env.DB.prepare(
    "SELECT id, kind, title, description, invite_mode, edit_mode, mention_mode, created_by FROM chats WHERE id = ?",
  )
    .bind(chatId)
    .first<{ id: number; kind: string; title: string; description: string | null; invite_mode: string; edit_mode: string; mention_mode: string; created_by: number | null }>();
  if (!chat) return json({ error: "Чат не найден" }, 404);
  if (chat.kind === "personal" || chat.kind === "favorites") return json({ error: "У этого чата нет настроек" }, 400);

  const isCreator = chat.created_by === user.id;
  if (chat.kind === "group") {
    if (!(await canAccessChat(env, user, { id: chat.id, kind: chat.kind }))) return json({ error: "Нет доступа" }, 403);
    if (!(isCreator || chat.edit_mode === "all")) return json({ error: "Менять информацию может только создатель" }, 403);
  } else if (!isCommittee(user)) {
    return json({ error: "Менять настройки этого чата может только комсостав" }, 403);
  }

  const body = await readJson(request);
  // Название меняется в группе и в общих чатах (общий, комсостав)
  const titleEditable = chat.kind === "group" || chat.kind === "general" || chat.kind === "committee";
  const title = titleEditable ? str(body.title, 60) || chat.title : chat.title;
  // Права: в группе — только создатель, в общих чатах — комсостав (проверено выше)
  const manager = chat.kind === "group" ? isCreator : true;
  const description = str(body.description, 500) || null;
  // Права меняет только создатель группы
  const inviteMode = manager && body.invite_mode === "creator" ? "creator" : manager && body.invite_mode === "all" ? "all" : chat.invite_mode;
  const editMode = manager && body.edit_mode === "creator" ? "creator" : manager && body.edit_mode === "all" ? "all" : chat.edit_mode;

  const mentionMode = manager && body.mention_mode === "creator" ? "creator" : manager && body.mention_mode === "all" ? "all" : chat.mention_mode;

  await env.DB.prepare("UPDATE chats SET title = ?, description = ?, invite_mode = ?, edit_mode = ?, mention_mode = ? WHERE id = ?")
    .bind(title, description, inviteMode, editMode, mentionMode, chatId)
    .run();
  return json({ ok: true });
}

// ---------- Галерея ----------
// Альбомы и фотографии. Метаданные в D1, файлы — на Google Диске в папке приложения.
// Диск подключает комсостав или пресрук один раз через OAuth (scope drive.file).

const GALLERY_ADMIN_ROLES: Role[] = ["master", "commissar", "commander", "press"];
const GALLERY_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const GALLERY_MAX_PHOTO = 20 * 1024 * 1024;
const GALLERY_FOLDER = "Белые Ночи — Галерея";
const GALLERY_CAPTION_MAX = 500;

function canManageGallery(user: UserRow): boolean {
  return GALLERY_ADMIN_ROLES.includes(user.role);
}

interface AlbumRow {
  id: number;
  title: string;
  description: string;
  cover_photo_id: number | null;
  upload_scope: string;
  created_by: number;
  created_by_name: string;
  created_at: string;
  photos_count: number;
}

interface PhotoRow {
  id: number;
  album_id: number;
  drive_file_id: string;
  mime: string;
  name: string;
  caption: string;
  added_by: number;
  added_by_name: string;
  created_at: string;
}

async function galleryConfigured(env: Env): Promise<boolean> {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

async function gdriveAuth(env: Env): Promise<{ refresh_token: string; folder_id: string; connected_by: number; connected_at: string } | null> {
  return await env.DB.prepare("SELECT refresh_token, folder_id, connected_by, connected_at FROM gdrive_auth WHERE id = 1")
    .first<{ refresh_token: string; folder_id: string; connected_by: number; connected_at: string }>();
}

async function galleryConnected(env: Env): Promise<boolean> {
  return (await galleryConfigured(env)) && Boolean(await gdriveAuth(env));
}

// Токен доступа Google: обновляем по refresh_token и держим в KV, чтобы не ходить за ним на каждый запрос
async function driveToken(env: Env): Promise<string | null> {
  if (!(await galleryConfigured(env))) return null;
  const cached = await env.FILES.get("gal:token");
  if (cached) return cached;
  const auth = await gdriveAuth(env);
  if (!auth) return null;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID ?? "",
      client_secret: env.GOOGLE_CLIENT_SECRET ?? "",
      refresh_token: auth.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    console.error("Drive token", res.status, await res.text());
    return null;
  }
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) return null;
  await env.FILES.put("gal:token", data.access_token, { expirationTtl: Math.max(60, (data.expires_in ?? 3600) - 60) });
  return data.access_token;
}

// Загрузка фото на Диск: сначала содержимое, затем имя и папка
async function driveUpload(env: Env, token: string, folderId: string, name: string, mime: string, bytes: ArrayBuffer): Promise<string | null> {
  const up = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=media&fields=id", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": mime },
    body: bytes,
  });
  if (!up.ok) {
    console.error("Drive upload", up.status, await up.text());
    return null;
  }
  const created = (await up.json()) as { id?: string };
  if (!created.id) return null;
  const patch = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(created.id)}?addParents=${encodeURIComponent(folderId)}&fields=id`,
    {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name }),
    },
  );
  if (!patch.ok) console.error("Drive rename", patch.status, await patch.text());
  return created.id;
}

async function driveDelete(env: Env, token: string | null, fileId: string): Promise<void> {
  if (!token) return;
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok && res.status !== 404) console.error("Drive delete", res.status, await res.text());
}

// Список альбомов: видят все подтверждённые участники
async function listAlbums(request: Request, env: Env): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const rows = (
    await env.DB.prepare(
      `SELECT a.id, a.title, a.description, a.cover_photo_id, a.upload_scope, a.created_by, a.created_at,
              u.full_name AS created_by_name,
              (SELECT COUNT(*) FROM album_photos p WHERE p.album_id = a.id) AS photos_count
         FROM albums a JOIN users u ON u.id = a.created_by
        ORDER BY a.id DESC`,
    ).all<AlbumRow>()
  ).results;
  const manager = canManageGallery(user);
  return json({
    albums: rows.map((r) => ({
      ...r,
      can_manage: manager || r.created_by === user.id,
      can_upload: manager || r.created_by === user.id || r.upload_scope === "all",
    })),
    can_manage: manager,
    configured: await galleryConfigured(env),
    connected: await galleryConnected(env),
  });
}

async function albumRow(env: Env, id: number): Promise<AlbumRow | null> {
  return await env.DB.prepare(
    `SELECT a.id, a.title, a.description, a.cover_photo_id, a.upload_scope, a.created_by, a.created_at,
            u.full_name AS created_by_name,
            (SELECT COUNT(*) FROM album_photos p WHERE p.album_id = a.id) AS photos_count
       FROM albums a JOIN users u ON u.id = a.created_by WHERE a.id = ?`,
  )
    .bind(id)
    .first<AlbumRow>();
}

async function createAlbum(request: Request, env: Env): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  if (!canManageGallery(user)) return json({ error: "Создавать альбомы может комсостав и пресрук" }, 403);
  const body = await readJson(request);
  const title = str(body.title, 120);
  if (!title) return json({ error: "Укажите название альбома" }, 400);
  const description = str(body.description, 1000);
  const scope = body.upload_scope === "all" ? "all" : "managers";
  const res = await env.DB.prepare("INSERT INTO albums (title, description, upload_scope, created_by) VALUES (?, ?, ?, ?)")
    .bind(title, description, scope, user.id)
    .run();
  return json({ album: await albumRow(env, Number(res.meta.last_row_id)) }, 201);
}

async function getAlbum(request: Request, env: Env, id: number): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const album = await albumRow(env, id);
  if (!album) return json({ error: "Альбом не найден" }, 404);
  const photos = (
    await env.DB.prepare(
      `SELECT p.id, p.album_id, p.drive_file_id, p.mime, p.name, p.caption, p.added_by, p.created_at,
              u.full_name AS added_by_name
         FROM album_photos p JOIN users u ON u.id = p.added_by
        WHERE p.album_id = ? ORDER BY p.id`,
    )
      .bind(id)
      .all<PhotoRow>()
  ).results;
  const manager = canManageGallery(user);
  const canManageAlbum = manager || album.created_by === user.id;
  return json({
    album: { ...album, can_manage: canManageAlbum },
    photos: photos.map((p) => ({
      id: p.id,
      caption: p.caption,
      mime: p.mime,
      name: p.name,
      added_by: p.added_by,
      added_by_name: p.added_by_name,
      created_at: p.created_at,
      can_delete: canManageAlbum || p.added_by === user.id,
    })),
    can_upload: canManageAlbum || album.upload_scope === "all",
    connected: await galleryConnected(env),
  });
}

async function updateAlbum(request: Request, env: Env, id: number): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const album = await albumRow(env, id);
  if (!album) return json({ error: "Альбом не найден" }, 404);
  if (!(canManageGallery(user) || album.created_by === user.id)) {
    return json({ error: "Менять альбом может создатель, комсостав и пресрук" }, 403);
  }
  const body = await readJson(request);
  const title = body.title === undefined ? album.title : str(body.title, 120);
  if (!title) return json({ error: "Укажите название альбома" }, 400);
  const description = body.description === undefined ? album.description : str(body.description, 1000);
  const scope = body.upload_scope === undefined ? album.upload_scope : body.upload_scope === "all" ? "all" : "managers";
  await env.DB.prepare("UPDATE albums SET title = ?, description = ?, upload_scope = ? WHERE id = ?")
    .bind(title, description, scope, id)
    .run();
  return json({ album: await albumRow(env, id) });
}

async function deleteAlbum(request: Request, env: Env, id: number): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const album = await albumRow(env, id);
  if (!album) return json({ error: "Альбом не найден" }, 404);
  if (!(canManageGallery(user) || album.created_by === user.id)) {
    return json({ error: "Удалить альбом может создатель, комсостав и пресрук" }, 403);
  }
  const photos = (
    await env.DB.prepare("SELECT id, drive_file_id FROM album_photos WHERE album_id = ?").bind(id).all<{ id: number; drive_file_id: string }>()
  ).results;
  const token = await driveToken(env);
  for (const p of photos) await driveDelete(env, token, p.drive_file_id);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM album_photos WHERE album_id = ?").bind(id),
    env.DB.prepare("DELETE FROM albums WHERE id = ?").bind(id),
  ]);
  return json({ ok: true });
}

async function addAlbumPhoto(request: Request, env: Env, albumId: number): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const album = await albumRow(env, albumId);
  if (!album) return json({ error: "Альбом не найден" }, 404);
  const manager = canManageGallery(user);
  if (!(manager || album.created_by === user.id || album.upload_scope === "all")) {
    return json({ error: "В этот альбом фото добавляет комсостав и пресрук" }, 403);
  }
  if (!(await galleryConnected(env))) {
    return json({ error: "Google Диск не подключён" }, 503);
  }
  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!GALLERY_TYPES.includes(type)) return json({ error: "Можно загружать только фото: jpg, png, webp, gif" }, 400);
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0) return json({ error: "Пустой файл" }, 400);
  if (bytes.byteLength > GALLERY_MAX_PHOTO) return json({ error: "Фото больше 20 МБ" }, 413);
  const name = decodeHeader(request.headers.get("x-file-name"), 200) || `Фото ${Date.now()}`;
  const caption = decodeHeader(request.headers.get("x-caption"), GALLERY_CAPTION_MAX);
  const token = await driveToken(env);
  const auth = await gdriveAuth(env);
  if (!token || !auth) return json({ error: "Не удалось войти в Google Диск, подключите его заново" }, 502);
  const fileId = await driveUpload(env, token, auth.folder_id, name, type, bytes);
  if (!fileId) return json({ error: "Google Диск не принял файл, попробуйте ещё раз" }, 502);
  const res = await env.DB.prepare(
    "INSERT INTO album_photos (album_id, drive_file_id, mime, name, caption, added_by) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(albumId, fileId, type, name, caption, user.id)
    .run();
  const photoId = Number(res.meta.last_row_id);
  if (album.cover_photo_id === null) {
    await env.DB.prepare("UPDATE albums SET cover_photo_id = ? WHERE id = ?").bind(photoId, albumId).run();
  }
  return json({ photo: { id: photoId, caption } }, 201);
}

// Отдача фото: файл тянем с Диска и отдаём браузеру (ссылки Диска требуют входа в Google)
async function getAlbumPhoto(request: Request, env: Env, id: number): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const row = await env.DB.prepare("SELECT drive_file_id, mime, name FROM album_photos WHERE id = ?")
    .bind(id)
    .first<{ drive_file_id: string; mime: string; name: string }>();
  if (!row) return json({ error: "Фото не найдено" }, 404);
  const token = await driveToken(env);
  if (!token) return json({ error: "Google Диск не подключён" }, 503);
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(row.drive_file_id)}?alt=media`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok || !res.body) {
    console.error("Drive read", res.status, await res.text());
    return json({ error: "Не удалось открыть фото" }, 502);
  }
  return new Response(res.body, {
    headers: {
      "content-type": row.mime,
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
      ...CORS,
    },
  });
}

async function updateAlbumPhoto(request: Request, env: Env, id: number): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const row = await env.DB.prepare("SELECT added_by FROM album_photos WHERE id = ?").bind(id).first<{ added_by: number }>();
  if (!row) return json({ error: "Фото не найдено" }, 404);
  if (!(canManageGallery(user) || row.added_by === user.id)) {
    return json({ error: "Менять подпись может загрузивший, комсостав и пресрук" }, 403);
  }
  const body = await readJson(request);
  const caption = str(body.caption, GALLERY_CAPTION_MAX);
  await env.DB.prepare("UPDATE album_photos SET caption = ? WHERE id = ?").bind(caption, id).run();
  return json({ ok: true });
}

async function deleteAlbumPhoto(request: Request, env: Env, id: number): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  const row = await env.DB.prepare("SELECT album_id, drive_file_id, added_by FROM album_photos WHERE id = ?")
    .bind(id)
    .first<{ album_id: number; drive_file_id: string; added_by: number }>();
  if (!row) return json({ error: "Фото не найдено" }, 404);
  if (!(canManageGallery(user) || row.added_by === user.id)) {
    return json({ error: "Удалить фото может загрузивший, комсостав и пресрук" }, 403);
  }
  await driveDelete(env, await driveToken(env), row.drive_file_id);
  await env.DB.prepare("DELETE FROM album_photos WHERE id = ?").bind(id).run();
  // Обложка была эта фотография — ставим следующую по порядку
  const album = await env.DB.prepare("SELECT cover_photo_id FROM albums WHERE id = ?").bind(row.album_id).first<{ cover_photo_id: number | null }>();
  if (album?.cover_photo_id === id) {
    const next = await env.DB.prepare("SELECT MIN(id) AS id FROM album_photos WHERE album_id = ?")
      .bind(row.album_id)
      .first<{ id: number | null }>();
    await env.DB.prepare("UPDATE albums SET cover_photo_id = ? WHERE id = ?").bind(next?.id ?? null, row.album_id).run();
  }
  return json({ ok: true });
}

// Подключение Google Диска: комсостав или пресрук нажимает кнопку, возвращается с ?gallery=connected
async function galleryOAuthStart(request: Request, env: Env): Promise<Response> {
  const user = await approvedUser(request, env);
  if (!user) return json({ error: "Нужен вход" }, 401);
  if (!canManageGallery(user)) return json({ error: "Подключить Диск может комсостав и пресрук" }, 403);
  if (!(await galleryConfigured(env))) {
    return json({ error: "Google Диск не настроен на сервере: нужны GOOGLE_CLIENT_ID и GOOGLE_CLIENT_SECRET" }, 503);
  }
  const url = new URL(request.url);
  const state = randomToken(16);
  const site = url.searchParams.get("origin") ?? "";
  const origin = /^https?:\/\/[a-z0-9.:\-]+$/i.test(site) ? site : url.origin;
  await env.FILES.put(`galstate:${state}`, JSON.stringify({ user_id: user.id, origin }), { expirationTtl: 900 });
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID ?? "",
    redirect_uri: `${url.origin}/api/gallery/oauth/callback`,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/drive.file",
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` });
}

async function galleryOAuthCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return json({ error: "Нет кода доступа" }, 400);
  const raw = await env.FILES.get(`galstate:${state}`);
  if (!raw) return json({ error: "Ссылка устарела: начните подключение заново" }, 400);
  await env.FILES.delete(`galstate:${state}`);
  let saved: { user_id: number; origin: string };
  try {
    saved = JSON.parse(raw) as { user_id: number; origin: string };
  } catch {
    return json({ error: "Плохое состояние входа" }, 400);
  }
  const redirectTo = (status: string) =>
    Response.redirect(`${saved.origin || url.origin}/?gallery=${status}`, 302);
  if (!(await galleryConfigured(env))) return redirectTo("error");
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID ?? "",
      client_secret: env.GOOGLE_CLIENT_SECRET ?? "",
      redirect_uri: `${url.origin}/api/gallery/oauth/callback`,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) {
    console.error("Drive code exchange", tokenRes.status, await tokenRes.text());
    return redirectTo("error");
  }
  const tokens = (await tokenRes.json()) as { access_token?: string; refresh_token?: string };
  if (!tokens.access_token || !tokens.refresh_token) return redirectTo("error");
  const folderRes = await fetch("https://www.googleapis.com/drive/v3/files?fields=id", {
    method: "POST",
    headers: { authorization: `Bearer ${tokens.access_token}`, "content-type": "application/json" },
    body: JSON.stringify({ name: GALLERY_FOLDER, mimeType: "application/vnd.google-apps.folder" }),
  });
  if (!folderRes.ok) {
    console.error("Drive folder", folderRes.status, await folderRes.text());
    return redirectTo("error");
  }
  const folder = (await folderRes.json()) as { id?: string };
  if (!folder.id) return redirectTo("error");
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO gdrive_auth (id, refresh_token, folder_id, connected_by, connected_at) VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET refresh_token = excluded.refresh_token, folder_id = excluded.folder_id,
       connected_by = excluded.connected_by, connected_at = excluded.connected_at`,
  )
    .bind(tokens.refresh_token, folder.id, saved.user_id, now)
    .run();
  await env.FILES.delete("gal:token");
  return redirectTo("connected");
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
      const usernameMatch = path.match(/^\/api\/profiles\/by-username\/([^/]+)$/);
      if (method === "GET" && usernameMatch) return await getProfileByUsername(request, env, decodeURIComponent(usernameMatch[1]));
      const profileMatch = path.match(/^\/api\/profiles\/(\d+)(\/private)?$/);
      if (method === "GET" && profileMatch) {
        const id = Number(profileMatch[1]);
        return profileMatch[2]
          ? await getPrivateProfile(request, env, id)
          : await getProfile(request, env, id);
      }

      if (method === "GET" && path === "/api/ably/token") return await ablyToken(request, env);
      if (method === "GET" && path === "/api/chats") return await listChats(request, env);
      if (method === "POST" && path === "/api/chats") return await createChat(request, env);
      const chatMessagesMatch = path.match(/^\/api\/chats\/(\d+)\/messages$/);
      if (chatMessagesMatch && method === "GET") return await listMessages(request, env, Number(chatMessagesMatch[1]), url);
      if (chatMessagesMatch && method === "POST") return await sendMessage(request, env, Number(chatMessagesMatch[1]), ctx);
      const chatCanvasMatch = path.match(/^\/api\/chats\/(\d+)\/canvases$/);
      if (chatCanvasMatch && method === "POST") return await createCanvas(request, env, Number(chatCanvasMatch[1]));
      const canvasMatch = path.match(/^\/api\/canvases\/(\d+)$/);
      if (canvasMatch && method === "GET") return await getCanvas(request, env, Number(canvasMatch[1]));
      if (method === "GET" && path === "/api/calls/ice") return await callIce(request, env);
      const chatCallMatch = path.match(/^\/api\/chats\/(\d+)\/calls$/);
      if (chatCallMatch && method === "POST") return await startCall(request, env, Number(chatCallMatch[1]));
      const callActionMatch = path.match(/^\/api\/calls\/(\d+)\/(join|leave|signal|ping)$/);
      if (callActionMatch && method === "POST") {
        const cid = Number(callActionMatch[1]);
        if (callActionMatch[2] === "join") return await joinCall(request, env, cid);
        if (callActionMatch[2] === "leave") return await leaveCall(request, env, cid);
        if (callActionMatch[2] === "ping") return await pingCall(request, env, cid);
        return await signalCall(request, env, cid);
      }
      const canvasHistoryMatch = path.match(/^\/api\/canvases\/(\d+)\/history$/);
      if (canvasHistoryMatch && method === "GET") return await canvasHistory(request, env, Number(canvasHistoryMatch[1]));
      const canvasStrokeMatch = path.match(/^\/api\/canvases\/(\d+)\/strokes$/);
      if (canvasStrokeMatch && method === "POST") return await addStroke(request, env, Number(canvasStrokeMatch[1]));
      if (canvasStrokeMatch && method === "DELETE") return await clearCanvas(request, env, Number(canvasStrokeMatch[1]));
      const chatMediaMatch = path.match(/^\/api\/chats\/(\d+)\/media$/);
      if (chatMediaMatch && method === "GET") return await chatMedia(request, env, Number(chatMediaMatch[1]), url);
      const chatSearchMatch = path.match(/^\/api\/chats\/(\d+)\/search$/);
      if (chatSearchMatch && method === "GET") return await searchMessages(request, env, Number(chatSearchMatch[1]), url);
      const chatMembersMatch = path.match(/^\/api\/chats\/(\d+)\/members$/);
      if (chatMembersMatch && method === "GET") return await listChatMembers(request, env, Number(chatMembersMatch[1]));
      if (chatMembersMatch && method === "POST") return await addChatMembers(request, env, Number(chatMembersMatch[1]));
      const chatAdminMatch = path.match(/^\/api\/chats\/(\d+)\/members\/(\d+)\/admin$/);
      if (chatAdminMatch && method === "PUT") return await setChatAdmin(request, env, Number(chatAdminMatch[1]), Number(chatAdminMatch[2]));
      if (method === "GET" && path === "/api/chat-admin-targets") return await listAdminChats(request, env);
      const chatLeaveMatch = path.match(/^\/api\/chats\/(\d+)\/members\/me$/);
      if (chatLeaveMatch && method === "DELETE") return await leaveChat(request, env, Number(chatLeaveMatch[1]));
      if (method === "GET" && path === "/api/push/key") return await pushKey(env);
      if (method === "POST" && path === "/api/push/subscribe") return await savePushSubscription(request, env);
      if (method === "DELETE" && path === "/api/push/subscribe") return await removePushSubscription(request, env);
      const chatSettingsMatch = path.match(/^\/api\/chats\/(\d+)\/settings$/);
      if (chatSettingsMatch && method === "PUT") return await updateChatSettings(request, env, Number(chatSettingsMatch[1]));
      const chatPhotoMatch = path.match(/^\/api\/chats\/(\d+)\/photo$/);
      if (chatPhotoMatch && method === "PUT") return await setChatPhoto(request, env, Number(chatPhotoMatch[1]));
      const chatReadMatch = path.match(/^\/api\/chats\/(\d+)\/read$/);
      if (chatReadMatch && method === "POST") return await markRead(request, env, Number(chatReadMatch[1]));
      const messageMatch = path.match(/^\/api\/messages\/(\d+)$/);
      if (messageMatch && method === "PUT") return await editMessage(request, env, Number(messageMatch[1]));
      if (messageMatch && method === "DELETE") return await deleteMessage(request, env, Number(messageMatch[1]));
      const messagePinMatch = path.match(/^\/api\/messages\/(\d+)\/pin$/);
      if (messagePinMatch && method === "PUT") return await pinMessage(request, env, Number(messagePinMatch[1]));
      const messageForwardMatch = path.match(/^\/api\/messages\/(\d+)\/forward$/);
      if (messageForwardMatch && method === "POST") return await forwardMessage(request, env, Number(messageForwardMatch[1]));

      if (method === "GET" && path === "/api/info") return await listInfo(request, env);
      const infoMatch = path.match(/^\/api\/info\/([a-z0-9-]{1,40})$/);
      if (infoMatch && method === "GET") return await getInfo(request, env, infoMatch[1]);
      if (infoMatch && method === "PUT") return await updateInfo(request, env, infoMatch[1]);

      if (method === "POST" && path === "/api/files") return await uploadFile(request, env);
      const fileMatch = path.match(/^\/api\/files\/([A-Za-z0-9_-]+)$/);
      if (method === "GET" && fileMatch) return await getFile(request, env, fileMatch[1]);

      if (method === "GET" && path === "/api/songs") return await listSongs(request, env);
      if (method === "POST" && path === "/api/songs") return await addSong(request, env);
      if (method === "GET" && path === "/api/posts") return await listPosts(request, env);
      if (method === "POST" && path === "/api/posts") return await addPost(request, env);
      if (method === "POST" && path === "/api/reactions") return await toggleReaction(request, env);

      if (method === "GET" && path === "/api/boards") return await listBoards(request, env);
      if (method === "POST" && path === "/api/boards") return await createBoard(request, env);
      const boardMatch = path.match(/^\/api\/boards\/(\d+)$/);
      if (boardMatch && method === "GET") return await getBoard(request, env, Number(boardMatch[1]));
      if (boardMatch && method === "PUT") return await updateBoard(request, env, Number(boardMatch[1]));
      if (boardMatch && method === "DELETE") return await deleteBoard(request, env, Number(boardMatch[1]));
      const boardColsMatch = path.match(/^\/api\/boards\/(\d+)\/columns$/);
      if (boardColsMatch && method === "POST") return await createBoardColumn(request, env, Number(boardColsMatch[1]));
      const boardColMatch = path.match(/^\/api\/boards\/(\d+)\/columns\/(\d+)$/);
      if (boardColMatch && method === "PUT") return await updateBoardColumn(request, env, Number(boardColMatch[1]), Number(boardColMatch[2]));
      if (boardColMatch && method === "DELETE") return await deleteBoardColumn(request, env, Number(boardColMatch[1]), Number(boardColMatch[2]));
      const boardOrderMatch = path.match(/^\/api\/boards\/(\d+)\/order$/);
      if (boardOrderMatch && method === "PUT") return await saveBoardOrder(request, env, Number(boardOrderMatch[1]));
      const boardCardsMatch = path.match(/^\/api\/boards\/(\d+)\/cards$/);
      if (boardCardsMatch && method === "POST") return await addBoardCard(request, env, Number(boardCardsMatch[1]));
      const boardCardMatch = path.match(/^\/api\/boards\/(\d+)\/cards\/(\d+)$/);
      if (boardCardMatch && method === "PUT") return await updateBoardCard(request, env, Number(boardCardMatch[1]), Number(boardCardMatch[2]));
      if (boardCardMatch && method === "DELETE") return await removeBoardCard(request, env, Number(boardCardMatch[1]), Number(boardCardMatch[2]));
      if (method === "GET" && path === "/api/tasks") return await listTasks(request, env);
      if (method === "POST" && path === "/api/tasks") return await createTask(request, env);
      if (method === "GET" && path === "/api/tasks/badge") return await taskBadge(request, env);
      const taskMatch = path.match(/^\/api\/tasks\/(\d+)$/);
      if (taskMatch && method === "PUT") return await updateTask(request, env, Number(taskMatch[1]));
      if (taskMatch && method === "DELETE") return await deleteTask(request, env, Number(taskMatch[1]));
      const taskStatusMatch = path.match(/^\/api\/tasks\/(\d+)\/status$/);
      if (taskStatusMatch && method === "PUT") return await setTaskStatus(request, env, Number(taskStatusMatch[1]));
      const taskColorMatch = path.match(/^\/api\/tasks\/(\d+)\/color$/);
      if (taskColorMatch && method === "PUT") return await setTaskColor(request, env, Number(taskColorMatch[1]));
      const taskDueMatch = path.match(/^\/api\/tasks\/(\d+)\/due$/);
      if (taskDueMatch && method === "PUT") return await setTaskDue(request, env, Number(taskDueMatch[1]));
      const taskCommentsMatch = path.match(/^\/api\/tasks\/(\d+)\/comments$/);
      if (taskCommentsMatch && method === "GET") return await listTaskComments(request, env, Number(taskCommentsMatch[1]));
      if (taskCommentsMatch && method === "POST") return await addTaskComment(request, env, Number(taskCommentsMatch[1]));
      const taskHistoryMatch = path.match(/^\/api\/tasks\/(\d+)\/history$/);
      if (taskHistoryMatch && method === "GET") return await listTaskHistory(request, env, Number(taskHistoryMatch[1]));
      const taskSubtasksMatch = path.match(/^\/api\/tasks\/(\d+)\/subtasks$/);
      if (taskSubtasksMatch && method === "POST") return await addSubtask(request, env, Number(taskSubtasksMatch[1]));
      const subtaskMatch = path.match(/^\/api\/subtasks\/(\d+)$/);
      if (subtaskMatch && method === "PUT") return await updateSubtask(request, env, Number(subtaskMatch[1]));
      if (subtaskMatch && method === "DELETE") return await deleteSubtask(request, env, Number(subtaskMatch[1]));
      const commentsMatch = path.match(/^\/api\/posts\/(\d+)\/comments$/);
      if (method === "GET" && commentsMatch) return await listComments(request, env, Number(commentsMatch[1]));
      if (method === "POST" && commentsMatch) return await addComment(request, env, Number(commentsMatch[1]));
      const commentMatch = path.match(/^\/api\/comments\/(\d+)$/);
      if (method === "DELETE" && commentMatch) return await deleteComment(request, env, Number(commentMatch[1]));
      const postMatch = path.match(/^\/api\/posts\/(\d+)$/);
      if (method === "DELETE" && postMatch) return await deletePost(request, env, Number(postMatch[1]));
      const voteMatch = path.match(/^\/api\/polls\/(\d+)\/vote$/);
      if (method === "POST" && voteMatch) return await votePoll(request, env, Number(voteMatch[1]));
      if (method === "POST" && path === "/api/attachments") return await uploadAttachment(request, env);
      const attMatch = path.match(/^\/api\/attachments\/([A-Za-z0-9_-]+)$/);
      if (method === "GET" && attMatch) return await getAttachment(request, env, attMatch[1]);

      const songAudioMatch = path.match(/^\/api\/songs\/([A-Za-z0-9_-]+)\/audio$/);
      if (method === "GET" && songAudioMatch) return await getSongAudio(request, env, songAudioMatch[1]);
      const songMatch = path.match(/^\/api\/songs\/([A-Za-z0-9_-]+)$/);
      if (method === "DELETE" && songMatch) return await deleteSong(request, env, songMatch[1]);

      if (method === "GET" && path === "/api/admin/members") return await listMembersAccess(request, env);
      const importantMatch = path.match(/^\/api\/admin\/users\/(\d+)\/important$/);
      if (method === "POST" && importantMatch) return await setImportantAccess(request, env, Number(importantMatch[1]));

      const adminMatch = path.match(/^\/api\/admin\/users\/(\d+)\/(approve|reject)$/);
      if (method === "POST" && adminMatch) {
        return await decide(request, env, Number(adminMatch[1]), adminMatch[2] as "approve" | "reject");
      }

      if (method === "GET" && path === "/api/gallery/albums") return await listAlbums(request, env);
      if (method === "POST" && path === "/api/gallery/albums") return await createAlbum(request, env);
      if (method === "GET" && path === "/api/gallery/oauth/start") return await galleryOAuthStart(request, env);
      if (method === "GET" && path === "/api/gallery/oauth/callback") return await galleryOAuthCallback(request, env);
      const albumMatch = path.match(/^\/api\/gallery\/albums\/(\d+)$/);
      if (albumMatch && method === "GET") return await getAlbum(request, env, Number(albumMatch[1]));
      if (albumMatch && method === "PUT") return await updateAlbum(request, env, Number(albumMatch[1]));
      if (albumMatch && method === "DELETE") return await deleteAlbum(request, env, Number(albumMatch[1]));
      const albumPhotosMatch = path.match(/^\/api\/gallery\/albums\/(\d+)\/photos$/);
      if (albumPhotosMatch && method === "POST") return await addAlbumPhoto(request, env, Number(albumPhotosMatch[1]));
      const galleryPhotoMatch = path.match(/^\/api\/gallery\/photos\/(\d+)$/);
      if (galleryPhotoMatch && method === "GET") return await getAlbumPhoto(request, env, Number(galleryPhotoMatch[1]));
      if (galleryPhotoMatch && method === "PUT") return await updateAlbumPhoto(request, env, Number(galleryPhotoMatch[1]));
      if (galleryPhotoMatch && method === "DELETE") return await deleteAlbumPhoto(request, env, Number(galleryPhotoMatch[1]));

      return json({ error: "Не найдено" }, 404);
    } catch (err) {
      // Подробности не отдаём в ответе, но пишем в журнал Cloudflare (npx wrangler tail)
      console.error("Ошибка", method, path, err instanceof Error ? `${err.name}: ${err.message}` : String(err));
      return json({ error: "Внутренняя ошибка сервера" }, 500);
    }
  },

  // Раз в минуту: напоминания о задачах
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(sendDueReminders(env));
  },
};
