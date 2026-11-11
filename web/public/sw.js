// Сервис-воркер: показывает push-уведомления о новых сообщениях, даже когда сайт закрыт.
// Текст сообщения сервер не передаёт, поэтому показываем общий текст.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  event.waitUntil(
    self.registration.showNotification("Белые Ночи", {
      body: "Новое уведомление",
      tag: "chat", // одно уведомление вместо кучи
      renotify: true,
      icon: "/favicon.ico",
      data: { url: "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) return client.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});
