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
//
// ПОЛИТИКА CSP: библиотеки с CDN этот worker скачивает сам, а такие запросы
// проверяются по `connect-src` политики, с которой он был УСТАНОВЛЕН — ею
// становится заголовок ответа `/sw.js` (см. vercel.json; <meta> из index.html
// на worker не действует). Политику браузер запоминает при установке, поэтому
// одной правки заголовка на хостинге мало: пока не изменится сам файл sw.js,
// у сотрудников останется старая политика и файлы с CDN будут отдавать 504 —
// так было в r2 (подробности в README → «Политика Content-Security-Policy»).
// =====================================================================

const APP_VERSION = '2.9.0';
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
//   r5 — рабочий стол финансиста собран в один блок «💰 Финансовые заявки»:
//        у счетов появилось меню «⏳ Ожидают оплату / ✅ Оплаченные», фильтр
//        периода у истории оплат и выгрузка в Excel по этому фильтру
//        (index.html, js/modules/invoices.js, js/modules/cash-requests.js,
//        js/i18n.js).
//   r6 — в окне «🧾 Счёт поставщика» появился выбор «🚚 Чья доставка»:
//        «🏬 доставка поставщика» входит в счёт, «🏢 доставка компании» — вне
//        счёта (строка «Доставка компании» в заявке, в реестре — «🏢 Вне счёта»)
//        (index.html, js/config.js, js/utils.js, js/i18n.js,
//        js/modules/orders.js, js/modules/registry.js).
//   v2.5.0 начинается с r1: имя кэша и так меняется вместе с APP_VERSION,
//   а история ревизий нужна внутри одной версии.
//   r1 — НДС (ПДВ) и своя доставка из подотчёта: в окне счёта появились
//        «Цены в счёте: без ПДВ / с ПДВ» и «Ставка ПДВ», в реестре — колонка
//        «в т.ч. ПДВ» и она же в выгрузке Excel, у своей доставки — выбор
//        «чем списываем» (подотчёт снабженца / другого сотрудника / фирма).
//        Своя доставка из подотчёта становится расходом кассы
//        (source = 'own_delivery'), поэтому строка заявки из денег больше не
//        считается — иначе сумма попала бы в итоги дважды
//        (database/migrate-v2.5.sql, js/config.js, js/utils.js, js/i18n.js,
//        index.html, js/modules/orders.js, js/modules/cash.js,
//        js/modules/registry.js, js/modules/dashboard.js).
//   r2 — подсказка при непройденной миграции называет НУЖНЫЙ файл: колонки НДС
//        и своей доставки ведут к database/migrate-v2.5.sql, а не к v2.4.0 —
//        иначе администратор запускал не тот файл и видел ту же ошибку снова.
//        В консоли та же подсказка называет версию НУЖНОЙ миграции (v2.4.0 для
//        payment_status), а не версию приложения
//        (js/database.js → MIGRATIONS, migrationForColumn(), explainError()).
//   r3 — оплата счёта на материалы — из окна подробностей: карточка очереди
//        целиком кликабельна, в списке стоит СТАТУС «⏳ Ожидает оплату» вместо
//        кнопки «✅ Оплачено» (в очереди «Ожидают оплату» она читалась как
//        «эти счета уже оплачены»), а сама кнопка живёт в окне
//        `#material-invoice-detail-modal` вместе с подробностями: суммы по
//        счёту и по заявке, даты, файл счёта и отметка «кто и когда оплатил»
//        (index.html, js/modules/invoices.js, js/i18n.js).
//   r4 — архив заявок на рабочем экране прораба: карточка заявки на
//        финансирование нажимается целиком и открывает подробное окно, у обоих
//        блоков появился фильтр «📥 Архив», а отработанную заявку (доставленную
//        по материалам / выданную и отклонённую по финансам) автор убирает в
//        архив кнопкой в карточке. Статус 'archived' у заявок на финансы знает
//        v2.6.0: база требует database/migrate-v2.6.sql
//        (database/migrate-v2.6.sql, index.html, js/database.js, js/utils.js,
//        js/i18n.js, js/modules/dashboard.js, js/modules/orders.js,
//        js/modules/cash-requests.js).
//   r5 — украинский интерфейс доведён до полного: в фразовый словарь PHRASES
//        добавлено около тысячи пар (было ~100), поэтому надписи модулей и
//        разметки, которые оставались русскими при переключении языка (рабочий
//        экран прораба «Задания от руководства», подсказки в окнах, таблицы,
//        тосты), теперь переводятся. Попутно translateText() переводит
//        многострочный текст разметки (фраза в словаре — одной строкой, а в
//        HTML внутри узла стоит перенос с отступом) и сохраняет пробелы по
//        краям узла: они разделяют соседние теги. Прогоны теперь проверяют и сам
//        словарь, и живую страницу: tools/checks/i18n-check.mjs (каждая пара
//        действительно переводит, ни одна не портит украинский, у каждой
//        надписи index.html есть перевод) и tools/checks/fin-workflow-check.mjs
//        (переключает язык в браузере и смотрит рабочий экран).
//   v2.6.0 начинается с r1: имя кэша и так меняется вместе с APP_VERSION,
//   а история ревизий нужна внутри одной версии. Правки, лежавшие в 2.5.0-r4
//   и 2.5.0-r5 (архив заявок на рабочем экране прораба и полный украинский
//   интерфейс), выпускаются первым же кэшем 2.6.0.
//   r1 — выпуск v2.6.0: архив заявок на финансы («📥 В архив») требует
//        database/migrate-v2.6.sql — файл правит только CHECK-ограничение
//        cash_requests_status_check (добавляет статус 'archived') и колонок
//        не добавляет, поэтому применяется отдельно от миграций колонок
//        (database/migrate-v2.6.sql, js/config.js, js/database.js).
//   v2.8.0 начинается с r1: имя кэша и так меняется вместе с APP_VERSION.
//   r1 — заявки создаёт БАЗА одной транзакцией, а не браузер несколькими
//        запросами. Команды create_order_with_items /
//        create_cash_request_with_items / issue_cash_request /
//        save_own_delivery_expense пишут заявку, её позиции и операции кассы
//        вместе и оставляют отметку в audit_log; номер («№ N/YY», «Ф-N/YY»)
//        присваивается под блокировкой, поэтому две одновременные заявки
//        больше не получают одинаковый номер. Прямой insert в orders и
//        cash_requests закрыт (revoke insert), права проверяет база
//        (database/migrate-v2.7-rls-finance.sql — политики,
//        database/migrate-v2.8-finance-rpc-audit.sql — команды и права на них,
//        js/database.js → RPC/rpc(), js/modules/orders.js,
//        js/modules/cash-requests.js). Позиции новой заявки на материалы
//        больше не помечаются «оплачено».
//   v2.9.0 начинается с r1: имя кэша и так меняется вместе с APP_VERSION.
//   r1 — масштабирование списков: заявки на материалы читаются СТРАНИЦАМИ
//        (25/50/100 строк) с фильтрами на сервере — вкладка статуса, права
//        прораба и поиск уходят в запрос, а не фильтруют выгруженную таблицу
//        в браузере. Появилась общая панель списка (js/pagination.js) и слой
//        страниц (js/database.js → selectPage/selectAllPaged/textSearch).
//        Индексы под эти запросы ставит database/migrate-v2.9-scale-indexes.sql
//        (index.html → панель «Снабжения», js/i18n.js → надписи панели,
//        js/modules/orders.js → список заявок).
//   r2 — фронтенд для прода (внешний вид не меняется, меняется доставка кода):
//        Tailwind больше не Play CDN, а собранный локально css/tailwind.css
//        (npm run build, отпечаток сборки сверяет frontend-check); в разметке
//        не осталось встроенных обработчиков — нажатия идут через data-action
//        и один диспетчер (js/actions.js), поэтому включена политика
//        Content-Security-Policy (meta в index.html + заголовок в vercel.json);
//        появились линтер (eslint.config.mjs) и сборка прогонов в CI
//        (.github/workflows/ci.yml). Файлы оболочки переустанавливаются у всех,
//        кто уже установил приложение: css/tailwind.css и js/actions.js
//        добавлены в APP_SHELL.
//   r3 — библиотеки с CDN снова скачиваются: в `connect-src` политики CSP
//        добавлены cdn.jsdelivr.net, cdnjs.cloudflare.com,
//        fonts.googleapis.com и fonts.gstatic.com (index.html + vercel.json).
//        Причина: запросы service worker-а проверяются по `connect-src`, а
//        политика берётся из заголовка ответа /sw.js и запоминается браузером
//        при установке — без переустановки worker-а сотрудники получали 504
//        вместо xlsx, supabase-js, frappe-gantt, html2canvas, jsPDF и шрифта
//        Manrope (см. README → «Политика Content-Security-Policy»).
//   r4 — журнал ошибок (эксплуатация): необработанные исключения и промисы
//        сотрудников уходят в базу — таблица public.app_errors и команда
//        rsk_log_app_errors (database/migrate-v2.9-ops-monitoring.sql), модуль
//        js/monitoring.js и его вызов в js/main.js. Читают журнал
//        Администратор и Директор; на локальном адресе журнал выключен, чтобы
//        проверочные прогоны с моком базы не писали в боевую базу.
//        Файлы оболочки переустанавливаются у всех, кто уже установил
//        приложение: в APP_SHELL добавлен js/monitoring.js.
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
    './css/tailwind.css',
    './css/theme.css',
    './js/main.js',
    './js/actions.js',
    './js/config.js',
    './js/monitoring.js',
    './js/utils.js',
    './js/i18n.js',
    './js/theme.js',
    './js/settings.js',
    './js/auth.js',
    './js/permissions.js',
    './js/database.js',
    './js/pagination.js',
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
        <a href="./index.html"
           style="display:inline-block;background:#15803d;color:#fff;border-radius:.5rem;padding:.75rem 1.5rem;
                  font-size:.875rem;font-weight:600;text-decoration:none">Обновить</a>
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
