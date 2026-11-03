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

// Картинка с защищённого адреса: браузер сам не передаёт заголовок входа, поэтому грузим через fetch
export async function loadImage(id: string): Promise<string | null> {
  const res = await fetch(baseUrl() + `/api/files/${id}`, { headers: authHeaders() });
  if (!res.ok) return null;
  return URL.createObjectURL(await res.blob());
}
