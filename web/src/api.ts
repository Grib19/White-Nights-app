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
    // Браузер может запретить хранение (приватный режим). Тогда войти придётся заново.
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function request(path: string, method = "GET", body?: unknown): Promise<{ status: number; data: any }> {
  if (!API_URL) throw new Error("Не задан адрес API (VITE_API_URL в web/.env.local)");

  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  const token = getToken();
  if (token) headers["authorization"] = `Bearer ${token}`;

  const res = await fetch(API_URL.replace(/\/$/, "") + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

export const ROLES = [
  { value: "candidate", label: "Кандидат" },
  { value: "fighter", label: "Боец" },
  { value: "master", label: "Мастер" },
  { value: "commissar", label: "Комиссар" },
  { value: "commander", label: "Командир" },
];

export const COMMITTEE_ROLES = ["master", "commissar", "commander"];
