/* Jeff service worker: Web Push only. No caching, no offline shell — the app
   stays server-rendered and owner-gated; this file only receives notifications. */

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = { title: "Jeff", body: "", url: "/", tag: "jeff" };
  try {
    if (event.data) data = Object.assign(data, event.data.json());
  } catch {
    if (event.data) data.body = event.data.text();
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "Jeff", {
      body: data.body || "",
      tag: data.tag || "jeff",
      renotify: false,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url: data.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) {
          client.focus();
          if ("navigate" in client) return client.navigate(target);
          return;
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});

// The browser rotated the subscription: re-subscribe and tell the server.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      const old = event.oldSubscription;
      const key = old && old.options ? old.options.applicationServerKey : undefined;
      if (!key) return;
      const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ subscription: sub.toJSON(), deviceLabel: "renewed" }),
      });
    })(),
  );
});
