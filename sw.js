// =====================================================================
// RSK ODESSA — SERVICE WORKER (PWA)
// =====================================================================
// Зачем он нужен: без service worker браузер не предложит «Установить
// приложение», а после установки приложение не откроется без сети.
//
// Что кэшируется (правила намеренно разные):
//   * открытие страницы (кнопка «Обновить» у карточки, см. js/pwa.js) —
//     СНАЧАЛА СЕТЬ, кэш только как запас: после выпуска новой версии
//     сотрудник получает свежий index.html сразу, без чистки кэша;
//   * файлы приложения и библиотеки с CDN — из кэша + тихое обновление
//     в фоне: запуск быстрый, интерфейс не «мигает»;
//   * запросы к базе (Cloudflare Worker-прокси и Supabase, см.
//     js/config.js → CONFIG.SUPABASE_URL) — НИКОГДА из кэша. Иначе
//     в интерфейсе останутся устаревшие суммы по объектам и подотчёту.
//
// Данные для офлайна здесь не хранятся: это только «оболочка» приложения.
//
// ВЫПУСК НОВОЙ ВЕРСИИ: поднять APP_VERSION (совпадает с CONFIG.APP.VERSION
// в js/config.js). Имя кэша изменится, старый кэш удалится в activate,
// а сотрудники увидят карточку «Доступна новая версия».
//
// ИСПРАВЛЕНИЯ БЕЗ СМЕНЫ ВЕРСИИ: поднимите SHELL_REVISION. Браузер
// переустанавливает service worker только тогда, когда изменился сам файл
// sw.js, и именно в этот момент заново скачивает файлы оболочки: без этого
// сотрудники с установленным приложением останутся на старых js/css.
// =====================================================================

const APP_VERSION = '2.4.0';
const CACHE_PREFIX = 'rsk-odessa';
// Ревизия оболочки — счётчик правок внутри одной версии, часть имени кэша
// (`rsk-odessa-v2.4.0-r3`, см. README → «Проверка после деплоя»). История:
//   r1 — правки от 20.09.2026: статус оплаты в карточке заявки, подписи в
//        окне «🚚 Доставлено на объект», понятное сообщение о неприменённой
//        миграции базы;
//   r2 — повторная переустановка той же оболочки: у сотрудников, которые уже
//        установили приложение, файлы js/css скачиваются заново;
//   r3 — объяснение отказа базы по CHECK-ограничению статусов
//        (js/database.js → explainError): «заявка не закрывается» теперь
//        ведёт к database/migrate-v2.4.sql, а не показывает английскую строку.
//   r4 — рабочий экран прораба: порядок «задачи → заявки на финансирование →
//        заявки на материалы», блоки заявок сворачиваются (dashboard.js);
//        директор деньги не выдаёт (кнопки «💵 Выдать» у него нет), а возврат
//        «На доработку» подсказывает database/fix-cash-requests-status-check.sql.
const SHELL_REVISION = 'r4';
const CACHE_NAME = `${CACHE_PREFIX}-v${APP_VERSION}-${SHELL_REVISION}`;

// Оболочка приложения: кладём в кэш сразу при установке. Список должен
// совпадать со структурой проекта — при опечатке будет 404 (см. warn ниже).
const APP_SHELL = [
    './',
    './index.html',
    './manifest.json',
    './logo.png',
    './css/style.css',
    './css/theme.css',
    './js/main.js',
    './js/config.js',
    './js/utils.js',
    './js/i18n.js',
    './js/theme.js',
    './js/settings.js',
    './js/auth.js',
    './js/permissions.js',
    './js/database.js',
    './js/pwa.js',
    './js/modules/dashboard.js',
    './js/modules/employees.js',
    './js/modules/projects.js',
    './js/modules/sections.js',
    './js/modules/estimate.js',
    './js/modules/gantt.js',
    './js/modules/orders.js',
    './js/modules/invoices.js',
    './js/modules/cash.js',
    './js/modules/cash-requests.js',
    './js/modules/registry.js',
    './js/modules/tasks.js',
    './js/modules/files.js',
    './js/modules/extra-costs.js',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './icons/maskable-192.png',
    './icons/maskable-512.png',
    './icons/apple-touch-icon.png'
];

// Хосты, ответы которых кэшировать нельзя: это живые данные, а не файлы.
//   *.workers.dev   — Cloudflare Worker-прокси к Supabase (CONFIG.SUPABASE_URL);
//   *.supabase.co / *.supabase.in — прямые обращения (Auth, Storage).
const API_HOST = /(^|\.)(workers\.dev|supabase\.co|supabase\.in)$/i;

// Мини-страница на случай «нет ни сети, ни кэша». Стили встроенные,
// без Tailwind: в офлайне внешние CDN могут быть недоступны.
const OFFLINE_HTML = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>RSK Odessa — нет соединения</title>
</head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
             background:#111827;color:#fff;font-family:system-ui,-apple-system,'Segoe UI',sans-serif">
    <div style="max-width:22rem;padding:2rem;text-align:center">
        <img src="./logo.png" alt="RSK Odessa" style="height:3rem;background:#fff;border-radius:.5rem;padding:.5rem">
        <h1 style="font-size:1.25rem;margin:1.25rem 0 .5rem">Нет соединения с интернетом</h1>
        <p style="font-size:.875rem;color:#9ca3af;margin:0 0 1.5rem">
            Приложение загрузилось из кэша, но данные объектов приходят с сервера.
            Проверьте связь и попробуйте ещё раз — введённые данные не потеряются.
        </p>
        <button onclick="location.reload()"
                style="background:#15803d;color:#fff;border:0;border-radius:.5rem;padding:.75rem 1.5rem;
                       font-size:.875rem;font-weight:600;cursor:pointer">Обновить</button>
    </div>
</body>
</html>`;

// =====================================================================
// УСТАНОВКА: кладём оболочку приложения в кэш
// =====================================================================

self.addEventListener('install', (event) => {
    event.waitUntil(precache());
});

async function precache() {
    const cache = await caches.open(CACHE_NAME);
    const results = await Promise.allSettled(
        APP_SHELL.map((url) => cache.add(new Request(url, { cache: 'reload' })))
    );
    results.forEach((result, index) => {
        if (result.status === 'rejected') {
            console.warn('[SW] не удалось закэшировать', APP_SHELL[index], result.reason);
        }
    });
    // Не ждём закрытия вкладок: новая версия вступает в силу сразу,
    // а приложение само предложит «Обновить» (см. js/pwa.js).
    await self.skipWaiting();
}

// =====================================================================
// АКТИВАЦИЯ: удаляем кэши прошлых версий
// =====================================================================

self.addEventListener('activate', (event) => {
    event.waitUntil(activate());
});

async function activate() {
    const names = await caches.keys();
    const stale = names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME);
    await Promise.all(stale.map((name) => caches.delete(name)));
    if (stale.length) {
        console.log('[SW] удалены кэши прошлых версий:', stale.join(', '));
    }
    await self.clients.claim();
}

// =====================================================================
// ПЕРЕХВАТ ЗАПРОСОВ
// =====================================================================

self.addEventListener('fetch', (event) => {
    const { request } = event;

    // Кэшируем только чтение: POST/PATCH/DELETE (сохранение в базу) идут напрямую.
    if (request.method !== 'GET') return;

    let url;
    try {
        url = new URL(request.url);
    } catch {
        return;
    }
    // Только http(s): схемы chrome-extension://, data:, blob: не кэшируем.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

    // Данные из базы — всегда в сеть, без исключений.
    if (API_HOST.test(url.hostname)) return;

    if (request.mode === 'navigate') {
        event.respondWith(networkFirst(request, event));
        return;
    }
    event.respondWith(cacheFirst(request, event));
});

/**
 * Открытие страницы: свежий HTML из сети; если сети нет — то, что в кэше.
 * @param {Request} request
 * @param {FetchEvent} event
 */
async function networkFirst(request, event) {
    try {
        const response = await fetch(request);
        if (response && response.ok) {
            keepAlive(event, putInCache(request, response.clone()));
        }
        return response;
    } catch (error) {
        const cached = await caches.match(request, { ignoreSearch: true });
        if (cached) return cached;
        const shell = await caches.match('./index.html');
        if (shell) return shell;
        return offlinePage();
    }
}

/**
 * Файлы приложения и библиотеки с CDN: отдаём из кэша сразу, а в фоне
 * обновляем — следующая загрузка будет свежей, ожидания нет.
 * @param {Request} request
 * @param {FetchEvent} event
 */
async function cacheFirst(request, event) {
    const cached = await caches.match(request);

    const fromNetwork = fetch(request).then((response) => {
        if (response && (response.ok || response.type === 'opaque')) {
            keepAlive(event, putInCache(request, response.clone()));
        }
        return response;
    });

    if (cached) {
        fromNetwork.catch(() => {});   // обновляем «тихо»: ошибку показывать нечем
        return cached;
    }

    const response = await fromNetwork.catch(() => null);
    if (response) return response;
    return new Response('', { status: 504, statusText: 'Offline' });
}

/** Кладёт ответ в кэш, не ломая запрос, если событие уже завершилось. */
function keepAlive(event, promise) {
    try {
        event.waitUntil(promise);
    } catch (error) {
        // Событие успело завершиться — ответ всё равно отдаётся приложению.
    }
}

async function putInCache(request, response) {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response);
}

function offlinePage() {
    return new Response(OFFLINE_HTML, {
        status: 200,
        statusText: 'Offline',
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
}

// =====================================================================
// СООБЩЕНИЯ ОТ ПРИЛОЖЕНИЯ
// =====================================================================

// Карточка «Доступна новая версия» (js/pwa.js) просит активировать скачанную версию.
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});
