import { request } from "./api";

// Превращает публичный ключ VAPID (base64url) в байты для подписки браузера
function keyToBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url + "=".repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function pushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && typeof Notification !== "undefined";
}

// Включает push. Возвращает текст ошибки или null, если всё получилось.
export async function enablePush(): Promise<string | null> {
  if (!pushSupported()) return "Этот браузер не поддерживает push-уведомления.";
  if (Notification.permission !== "granted") {
    const result = await Notification.requestPermission();
    if (result !== "granted") return "Браузер не разрешил уведомления. Разрешите их в настройках сайта.";
  }
  const { data } = await request("/api/push/key");
  if (!data?.key) return "На сервере ещё не настроены ключи push-уведомлений.";
  const reg = await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(data.key) }));
  const { status } = await request("/api/push/subscribe", "POST", sub.toJSON());
  if (status >= 400) return "Не удалось сохранить подписку на сервере.";
  return null;
}

// Выключает push для этого браузера
export async function disablePush(): Promise<void> {
  if (!pushSupported()) return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  await request("/api/push/subscribe", "DELETE", { endpoint: sub.endpoint });
  await sub.unsubscribe();
}
