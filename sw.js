const CACHE_NAME = 'byma-trader-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  'https://unpkg.com/react@18/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18/umd/react-dom.production.min.js',
  'https://unpkg.com/@babel/standalone/babel.min.js',
  'https://cdn.tailwindcss.com',
  'https://unpkg.com/recharts@2.12.7/umd/Recharts.js',
  'https://unpkg.com/lucide-react@0.383.0/dist/umd/lucide-react.js',
  'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=JetBrains+Mono:wght@300;400;500;600&display=swap'
];

// Install - pre-cache static assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(STATIC_ASSETS.map(url => new Request(url, { mode: 'cors' })))
        .catch(err => {
          console.warn('Some assets failed to cache:', err);
          // Cache what we can
          return Promise.allSettled(
            STATIC_ASSETS.map(url => cache.add(new Request(url, { mode: 'cors' })).catch(() => {}))
          );
        });
    })
  );
  self.skipWaiting();
});

// Activate - clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(names =>
      Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)))
    )
  );
  self.clients.claim();
});

// Fetch - network first for API, cache first for static
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Yahoo Finance API / CORS proxy - network only, no cache
  if (url.hostname.includes('yahoo') || url.hostname.includes('corsproxy') || url.hostname.includes('allorigins')) {
    event.respondWith(
      fetch(event.request).catch(() => new Response(JSON.stringify({ error: 'offline' }), {
        headers: { 'Content-Type': 'application/json' }
      }))
    );
    return;
  }

  // Static assets - cache first
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response.ok && event.request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        // Offline fallback for navigation
        if (event.request.mode === 'navigate') {
          return caches.match('/index.html');
        }
        return new Response('Offline', { status: 503 });
      });
    })
  );
});

// Background periodic scan (experimental - Periodic Background Sync)
self.addEventListener('periodicsync', event => {
  if (event.tag === 'byma-scan') {
    event.waitUntil(doBackgroundScan());
  }
});

async function doBackgroundScan() {
  // Minimal background scan - check portfolio prices and alerts
  try {
    const db = await openDB();
    const portfolio = await dbGet(db, 'portfolio');
    const alerts = await dbGet(db, 'alerts');
    if (!portfolio || !alerts) return;

    const tickers = [
      ...portfolio.positions.map(p => p.ticker),
      ...alerts.filter(a => a.active).map(a => a.ticker)
    ];
    const unique = [...new Set(tickers)];

    for (const ticker of unique) {
      try {
        const url = `https://corsproxy.io/?${encodeURIComponent(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=1d&interval=5m`)}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        const data = await res.json();
        const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
        if (!price) continue;

        // Check alerts
        const triggered = alerts.filter(a =>
          a.active && a.ticker === ticker &&
          (a.type === 'buy' ? price <= a.price : price >= a.price)
        );

        for (const alert of triggered) {
          self.registration.showNotification(`🔔 ${alert.type.toUpperCase()} - ${ticker.replace('.BA', '')}`, {
            body: `Precio: $${price.toLocaleString('es-AR')} | Alerta: $${alert.price.toLocaleString('es-AR')}`,
            icon: '/icon-192.png',
            tag: `alert-${alert.id}`,
            requireInteraction: true,
            data: { ticker, price, alertId: alert.id }
          });
        }
      } catch {}
    }
  } catch (err) {
    console.warn('Background scan error:', err);
  }
}

// IndexedDB helpers for SW
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('byma-trader', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('data')) db.createObjectStore('data');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbGet(db, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('data', 'readonly');
    const req = tx.objectStore('data').get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Notification click handler
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(clients => {
      if (clients.length > 0) {
        clients[0].focus();
        clients[0].postMessage({ type: 'ALERT_TRIGGERED', data: event.notification.data });
      } else {
        self.clients.openWindow('/');
      }
    })
  );
});
