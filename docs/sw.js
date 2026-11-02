// Service worker: makes the app installable, keeps the shell available offline,
// and receives images shared from other apps (Mi Fitness, Gallery) via the Android share sheet.

const CACHE = "tenth-shell-v2";
const SHARED = "tenth-shared";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./config.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== CACHE && key !== SHARED) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Image shared into the app from another app
  if (event.request.method === "POST" && url.href === new URL("./share", self.registration.scope).href) {
    event.respondWith(receiveShare(event.request));
    return;
  }

  // Only the app's own files are cached; Supabase, Gemini and Open Food Facts calls go straight to the network
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;

  // Network first so updates you push show up immediately; cache when offline
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true })),
  );
});

async function receiveShare(request) {
  const form = await request.formData();
  const file = form.get("file");
  if (file && typeof file !== "string") {
    const cache = await caches.open(SHARED);
    await cache.put(
      new URL("./__shared-image", self.registration.scope).href,
      new Response(file, {
        headers: {
          "Content-Type": file.type || "image/jpeg",
          "X-File-Name": encodeURIComponent(file.name || "shared.jpg"),
        },
      }),
    );
  }
  return Response.redirect(new URL("./?shared=1", self.registration.scope).href, 303);
}
