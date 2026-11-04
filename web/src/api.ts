// Обращения к API на Cloudflare Workers.
// Адрес API задаётся в web/.env.local: VITE_API_URL=https://white-nights-api.white-nights.workers.dev

export interface User {
  id: number;
  email: string;
  phone: string;
  full_name: string;
  role: string;
  status: string;
  created_at: string;
}

export const ROLES = [
  { value: "candidate", label: "Кандидат" },
  { value: "fighter", label: "Боец" },
  { value: "master", label: "Мастер" },
  { value: "commissar", label: "Комиссар" },
  { value: "commander", label: "Командир" },
];

export const COMMITTEE_ROLES = ["master", "commissar", "commander"];

export function roleLabel(role: string): string {
  return ROLES.find((r) => r.value === role)?.label ?? role;
}

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? "";
const TOKEN_KEY = "wn_token";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Браузер запретил хранение (приватный режим): войти придётся заново
  }
}

function baseUrl(): string {
  if (!API_URL) throw new Error("Не задан адрес API (VITE_API_URL в web/.env.local)");
  return API_URL.replace(/\/$/, "");
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function request(path: string, method = "GET", body?: unknown): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = { ...authHeaders() };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(baseUrl() + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

// Загрузка фото или PDF. Возвращает id файла.
export async function uploadFile(file: File): Promise<{ ok: boolean; id?: string; error?: string }> {
  const res = await fetch(baseUrl() + "/api/files", {
    method: "POST",
    headers: { ...authHeaders(), "content-type": file.type },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 201) return { ok: true, id: data.id };
  return { ok: false, error: data.error ?? "Не удалось загрузить файл" };
}

export interface Song {
  id: string;
  title: string;
  author: string;
  created_at: string;
}

// Загрузка песни (только комсостав). Название и автор уходят в заголовках, закодированными в URL.
export async function uploadSong(file: File, title: string, author: string): Promise<{ ok: boolean; error?: string }> {
  const type = file.type || (file.name.toLowerCase().endsWith(".m4a") ? "audio/mp4" : "audio/mpeg");
  const res = await fetch(baseUrl() + "/api/songs", {
    method: "POST",
    headers: {
      ...authHeaders(),
      "content-type": type,
      "x-song-title": encodeURIComponent(title),
      "x-song-author": encodeURIComponent(author),
    },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 201) return { ok: true };
  return { ok: false, error: data.error ?? "Не удалось загрузить песню" };
}

// Аудио песни с защищённого адреса: плееру нельзя передать заголовок входа, поэтому грузим через fetch
export async function loadAudio(id: string): Promise<string | null> {
  const res = await fetch(baseUrl() + `/api/songs/${id}/audio`, { headers: authHeaders() });
  if (!res.ok) return null;
  return URL.createObjectURL(await res.blob());
}

// Любой файл для поста (до 20 МБ). Возвращает id вложения.
export async function uploadAttachment(file: File): Promise<{ ok: boolean; id?: string; error?: string }> {
  const res = await fetch(baseUrl() + "/api/attachments", {
    method: "POST",
    headers: {
      ...authHeaders(),
      "content-type": file.type || "application/octet-stream",
      "x-file-name": encodeURIComponent(file.name),
    },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 201) return { ok: true, id: data.id };
  return { ok: false, error: data.error ?? "Не удалось загрузить файл" };
}

// Скачивание вложения: грузим с заголовком входа и сохраняем файл под его названием
export async function downloadAttachment(id: string, name: string): Promise<string | null> {
  const res = await fetch(baseUrl() + `/api/attachments/${id}`, { headers: authHeaders() });
  if (!res.ok) return "Не удалось скачать файл";
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return null;
}

// Картинка с защищённого адреса: браузер сам не передаёт заголовок входа, поэтому грузим через fetch
export async function loadImage(id: string): Promise<string | null> {
  const res = await fetch(baseUrl() + `/api/files/${id}`, { headers: authHeaders() });
  if (!res.ok) return null;
  return URL.createObjectURL(await res.blob());
}
