// =====================================================================
// RSK ODESSA — МАСШТАБИРОВАНИЕ СПИСКОВ (v2.9.0): ПРОГОН В БРАУЗЕРЕ
// =====================================================================
// Что проверяет: список заявок «Снабжения» читается СТРАНИЦЕЙ, а фильтры
// (вкладка статуса, поиск) уходят в запрос — а не фильтруют выгруженную
// таблицу в браузере. Именно это обещает этап «Масштабирование».
//
// Приложение отдаётся с локального сервера, «Supabase» подменён моком на
// 60 заявках; мок отвечает как PostgREST: понимает status=in.(...),
// order=..., or=(...ilike...), режет ответ по заголовку Range и, если
// приложение просит Prefer: count=exact, присылает общее число строк в
// Content-Range. Без этого «страницы» проверить нечем.
//
// Проверки (каждая — строка ok/FAIL, код возврата 1 при замечаниях):
//   1. вход и открытие раздела «Снабжение»            → 25 карточек;
//   2. запрос списка страничный: Range 0-24 + count=exact;
//   3. ни одного запроса /orders без диапазона (нет «выгрузи всё»);
//   4. надпись «Показано 1-25 из 35» — общее число дала база (count=exact),
//      а не браузер пересчитал выгруженное;
//   5. «Вперёд» открывает вторую страницу (26-35);
//   6. поиск уходит условием or=(...ilike...), а не фильтром в JS;
//   7. вкладка статуса — условие status=eq.closed в запросе.
//
// Запуск (из папки tools/checks):  node scale-check.mjs
// =====================================================================
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.APP_ROOT
    ? path.resolve(process.env.APP_ROOT)
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 8125;
const CDP_PORT = 9339;
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const USER_ID = '22222222-2222-4222-8222-222222222222';
// Снабженец: видит раздел «Снабжение» и ВСЕ заявки. Прораб видел бы только
// свои — на этой же странице фильтр created_by_employee_id, и он проверяется
// прогоном migration-check (связка «код ↔ индекс»).
const EMPLOYEE = {
    id: 7, name: 'Тест Снабженец', position: 'Снабженец', phone: '+380000000001',
    status: 'active', user_id: USER_ID, notes: null, created_at: '2026-01-01T00:00:00Z'
};

const PROJECT = { id: 3, name: 'Тестовый объект' };
const SECTION = { id: 5, name: 'Кладочные работы', project_id: 3 };

// 60 заявок: 20 новых + 15 в работе = 35 «Активных» (больше страницы в 25,
// поэтому есть вторая страница), 10 доставлено, 10 закрыто, 5 в архиве.
// «ООО Трубы Одесса» — у каждой двадцатой: на них проверяется поиск.
const ORDER_COUNT = 60;
const ORDERS = Array.from({ length: ORDER_COUNT }, (_, index) => {
    const number = index + 1;
    const status = number <= 20 ? 'new'
        : number <= 35 ? 'in_progress'
            : number <= 45 ? 'delivered'
                : number <= 55 ? 'closed' : 'archived';
    return {
        id: number,
        request_number: '№ ' + number + '/26',
        project_id: PROJECT.id,
        section_id: SECTION.id,
        status,
        supplier: number <= 3 ? 'ООО Трубы Одесса' : 'Цемент-Трейд',
        total_sum: 1000 + number,
        payment_source: 'company',
        payment_status: 'paid',
        created_by_employee_id: EMPLOYEE.id,
        payer_employee_id: null,
        invoice_path: null,
        paid_at: null,
        // Свежие сверху — как отдаёт база при order=created_at.desc
        created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, ORDER_COUNT - number)).toISOString(),
        project: { id: PROJECT.id, name: PROJECT.name },
        section: { id: SECTION.id, name: SECTION.name },
        created_by_emp: { id: EMPLOYEE.id, name: EMPLOYEE.name, position: EMPLOYEE.position },
        payer: null
    };
});

const ORDER_ITEMS = ORDERS.map((order) => ({
    id: order.id * 10, order_id: order.id, name: 'Цемент М400',
    unit: 'меш', qty: 10, unit_price: 100, total_price: 1000, payment_status: 'paid'
}));

const requests = [];
const report = [];
const log = (...a) => { const line = a.join(' '); report.push(line); console.log(line); };
let failed = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sendJson(res, status, payload, extraHeaders = {}) {
    const text = payload === undefined || payload === null ? '' : JSON.stringify(payload);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': 'Content-Range',
        ...extraHeaders
    });
    res.end(text);
}

const SESSION = {
    access_token: 'header.' + Buffer.from(JSON.stringify({
        sub: USER_ID, role: 'authenticated', email: 'test@example.com',
        exp: Math.floor(Date.now() / 1000) + 3600
    })).toString('base64url') + '.sig',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: 'refresh-test',
    user: {
        id: USER_ID, aud: 'authenticated', role: 'authenticated',
        email: 'test@example.com', app_metadata: {}, user_metadata: {},
        created_at: '2026-01-01T00:00:00Z'
    }
};

// ---------------------------------------------------------------------
// Отбор строк как в PostgREST: приложение присылает условия в строке
// запроса, а не фильтрует у себя. Мок понимает ровно то, что собирает
// js/database.js: status=eq.X / status=in.(...), eq-фильтры,
// or=(колонка.ilike.%текст%,...).
// ---------------------------------------------------------------------
function filterOrders(params) {
    let rows = ORDERS.slice();

    const status = params.status || '';
    const inList = /^in\.\((.+)\)$/.exec(status);
    if (inList) {
        const list = inList[1].split(',').map((value) => value.trim());
        rows = rows.filter((order) => list.includes(order.status));
    } else if (status) {
        rows = rows.filter((order) => order.status === status.replace(/^eq\./, ''));
    }

    ['id', 'project_id', 'section_id', 'created_by_employee_id', 'payer_employee_id',
        'payment_source', 'payment_status', 'request_number', 'supplier'].forEach((column) => {
        const raw = params[column];
        if (!raw) return;
        const value = String(raw).replace(/^eq\./, '');
        rows = rows.filter((order) => String(order[column]) === value);
    });

    const inProject = /^in\.\((.+)\)$/.exec(params.project_id || '');
    if (inProject) {
        const list = inProject[1].split(',').map((value) => value.trim());
        rows = rows.filter((order) => list.includes(String(order.project_id)));
    }

    // or=(колонка.ilike.%текст%,...) — поиск. Скобки ставит supabase-js,
    // поэтому двойные скобки (or=((...))) — ошибка разбора: PostgREST на них
    // отвечает 400 PGRST100. Отвечаем так же, иначе «лишние скобки» в коде
    // прошли бы незамеченными (так и случилось в первом прогоне).
    const or = params.or || '';
    if (or && !/^\([^()]+\)$/.test(or)) {
        return sendJson(res, 400, {
            code: 'PGRST100',
            message: 'failed to parse logic tree (' + or + ')',
            details: null, hint: null
        });
    }

    const terms = [...String(or).matchAll(/([a-z_]+)\.ilike\.%([^%]*)%/g)]
        .map((match) => ({ column: match[1], text: match[2].toLowerCase() }));
    if (terms.length) {
        rows = rows.filter((order) => terms.some((term) =>
            String(order[term.column] || '').toLowerCase().includes(term.text)));
    }

    return rows;
}

function filterOrderItems(params) {
    const raw = params.order_id || '';
    const inList = /^in\.\((.+)\)$/.exec(raw);
    if (inList) {
        const list = inList[1].split(',').map((value) => value.trim());
        return ORDER_ITEMS.filter((item) => list.includes(String(item.order_id)));
    }
    if (raw) {
        const value = String(raw).replace(/^eq\./, '');
        return ORDER_ITEMS.filter((item) => String(item.order_id) === value);
    }
    return ORDER_ITEMS;
}

/**
 * Ответ на чтение списка: отдаём РОВНО запрошенную страницу и, если
 * приложение попросило Prefer: count=exact, общее число строк в
 * Content-Range — как это делает PostgREST.
 *
 * ⚠️ supabase-js 2.45.4 для .range(from, to) ставит в запрос offset и limit
 *    (а не заголовок Range), поэтому страницу считаем по ним; заголовок
 *    Range поддерживаем тоже — так PostgREST умеет и так, и так, и мок
 *    должен отвечать одинаково.
 */
function sendRows(req, res, rows) {
    const params = Object.fromEntries(new URL(req.url, 'http://127.0.0.1').searchParams.entries());
    const range = /^(\d+)-(\d+)$/.exec(String(req.headers.range || ''));

    const from = params.offset !== undefined ? Number(params.offset)
        : range ? Number(range[1]) : 0;
    const size = params.limit !== undefined ? Number(params.limit)
        : range ? Number(range[2]) - Number(range[1]) + 1 : rows.length;

    const page = rows.slice(from, from + size);
    const total = String(req.headers.prefer || '').includes('count=exact') ? String(rows.length) : '*';
    const last = page.length ? from + page.length - 1 : 0;

    return sendJson(res, 200, page, {
        'Content-Range': from + '-' + last + '/' + total
    });
}

function handleMock(req, res, body) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;
    const params = Object.fromEntries(url.searchParams.entries());

    requests.push({
        method: req.method,
        target: p + url.search,
        body: body || '',
        limit: params.limit || '',
        offset: params.offset || '',
        prefer: String(req.headers.prefer || '')
    });

    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': '*',
            'Access-Control-Allow-Methods': '*'
        });
        res.end();
        return;
    }

    // ---- Auth ----
    if (p.includes('/auth/v1/token')) return sendJson(res, 200, SESSION);
    if (p.includes('/auth/v1/user')) return sendJson(res, 200, SESSION.user);
    if (p.includes('/auth/v1/logout')) return sendJson(res, 204, null);

    if (p.includes('/rest/v1/rpc/')) return sendJson(res, 200, { id: 1 });

    // ---- employees: вход и права ----
    if (p.includes('/rest/v1/employees')) {
        if (req.method === 'HEAD') {
            res.writeHead(200, { 'Content-Range': '0-0/1', 'Access-Control-Allow-Origin': '*' });
            res.end();
            return;
        }
        const rows = params.user_id || params.id ? [EMPLOYEE] : [EMPLOYEE];
        return sendRows(req, res, rows);
    }

    // ---- заявки и их позиции ----
    if (p.includes('/rest/v1/orders')) {
        if (req.method !== 'GET') return sendJson(res, 201, { id: 1 });
        return sendRows(req, res, filterOrders(params));
    }
    if (p.includes('/rest/v1/order_items')) return sendRows(req, res, filterOrderItems(params));
    if (p.includes('/rest/v1/projects')) return sendRows(req, res, [PROJECT]);
    if (p.includes('/rest/v1/sections')) return sendRows(req, res, [SECTION]);

    // Остальные таблицы этому экрану не нужны: пустой ответ — как пусто в базе.
    if (req.method === 'HEAD') {
        res.writeHead(200, { 'Content-Range': '*/0', 'Access-Control-Allow-Origin': '*' });
        res.end();
        return;
    }
    if (req.method === 'GET') return sendRows(req, res, []);

    return sendJson(res, 201, { id: 1 });
}

// ------------------------------ сервер приложения ------------------------------
const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.png': 'image/png', '.ico': 'image/x-icon', '.pdf': 'application/pdf'
};

const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);

    if (urlPath.startsWith('/mock/')) {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => handleMock(req, res, body));
        return;
    }

    const file = urlPath.endsWith('/') ? path.join(ROOT, 'index.html') : path.join(ROOT, urlPath);
    fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); res.end('not found'); return; }

        // Service worker в прогоне выключен: он кэширует GET-ответы и
        // показал бы старые js вместо только что изменённых.
        if (urlPath === '/sw.js') {
            res.writeHead(200, { 'Content-Type': MIME['.js'] });
            res.end('// тестовый прогон: service worker выключен\n');
            return;
        }

        let out = data;
        if (urlPath === '/js/config.js') {
            // Единственная правка: приложение ходит в мок, а не в боевую базу.
            out = Buffer.from(String(data).replace(
                /SUPABASE_URL: '[^']*'/,
                "SUPABASE_URL: 'http://127.0.0.1:" + PORT + "/mock'"
            ), 'utf8');
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
        res.end(out);
    });
});

// ------------------------------- CDP-клиент -------------------------------
let ws;
let nextId = 1;
const pending = new Map();
const consoleErrors = [];

function send(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
        pending.set(id, (msg) => (msg.error ? reject(new Error(method + ': ' + JSON.stringify(msg.error))) : resolve(msg.result)));
        ws.send(JSON.stringify({ id, method, params }));
    });
}

async function evaluate(expression) {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
        throw new Error('ошибка в странице: ' +
            JSON.stringify(result.exceptionDetails.exception?.description || result.exceptionDetails.text));
    }
    return result.result.value;
}

const getJson = async (url) => (await fetch(url)).json();

function prepareProfile(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
        return dir;
    } catch {
        const fallback = dir + '-' + process.pid;
        log('  профиль Chrome занят (' + dir + ') — использую ' + fallback);
        return fallback;
    }
}

/** Ждём, пока условие в странице станет истинным (или выйдет время). */
async function waitFor(expression, attempts = 60, delayMs = 250) {
    for (let i = 0; i < attempts; i += 1) {
        try {
            if (await evaluate(expression)) return true;
        } catch { /* страница ещё не готова — пробуем снова */ }
        await sleep(delayMs);
    }
    return false;
}

/**
 * Действие в странице + пауза ВНУТРИ страницы.
 *
 * ⚠️ Пауза внутри страницы, а не в Node: поиск отвечает по дебаунсу
 * (350 мс), а страничные запросы — асинхронные. Если отдать действие и
 * сразу вернуться в Node, пауза придётся на другой вызов CDP, и проверка
 * увидит список ещё до перерисовки (в первых прогонах так и было).
 */
async function pageAction(code, waitMs = 1500) {
    return evaluate(`(async () => {
        ${code}
        await new Promise((resolve) => setTimeout(resolve, ${waitMs}));
        return true;
    })()`);
}

/** Состояние списка заявок: сколько карточек и что написано в панели. */
const LIST_STATE = `(() => {
    const container = document.getElementById('orders-container');
    return {
        cards: container ? container.querySelectorAll('button[onclick*="openOrderDetail"]').length : 0,
        range: (document.getElementById('orders-range') || {}).textContent || '',
        page: (document.getElementById('orders-page') || {}).textContent || '',
        nextDisabled: !!(document.getElementById('orders-next') || {}).disabled,
        prevDisabled: !!(document.getElementById('orders-prev') || {}).disabled,
        numbers: container
            ? [...container.querySelectorAll('button[onclick*="openOrderDetail"]')].map((b) => b.textContent.trim().slice(0, 14))
            : []
    };
})()`;

/** Запросы списка заявок, как их увидел мок. */
const ordersGets = () => requests
    .filter((r) => r.method === 'GET' && r.target.includes('/rest/v1/orders'))
    .map((r) => ({ target: r.target, limit: r.limit, offset: r.offset, prefer: r.prefer }));

const lastOrdersGet = () => ordersGets().slice(-1)[0] || { target: '', limit: '', offset: '', prefer: '' };

// --------------------------------- прогон ---------------------------------
let chrome;
let PROFILE = path.join(os.tmpdir(), 'rsk-scale', 'chrome-profile');

try {
    await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
    log('Прогон: список заявок страницами (v2.9.0) | приложение: http://127.0.0.1:' + PORT + ' (Supabase → мок)');
    log('  данные мока: ' + ORDER_COUNT + ' заявок; «Активных» (new + in_progress): 35, из них страница 25');

    PROFILE = prepareProfile(PROFILE);
    chrome = spawn(CHROME, [
        '--headless=new', '--remote-debugging-port=' + CDP_PORT,
        '--user-data-dir=' + PROFILE, '--no-first-run', '--no-default-browser-check',
        '--disable-extensions', '--window-size=1280,900', 'about:blank'
    ], { stdio: 'ignore' });

    let version = null;
    for (let i = 0; i < 60 && !version; i++) {
        try { version = await getJson('http://127.0.0.1:' + CDP_PORT + '/json/version'); } catch { await sleep(500); }
    }
    if (!version) throw new Error('Chrome не поднялся');

    const targets = await getJson('http://127.0.0.1:' + CDP_PORT + '/json/list');
    const page = targets.find((t) => t.type === 'page');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    ws.addEventListener('message', (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id && pending.has(msg.id)) { const h = pending.get(msg.id); pending.delete(msg.id); h(msg); return; }
        if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
            consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
        }
        if (msg.method === 'Runtime.exceptionThrown') {
            consoleErrors.push('ИСКЛЮЧЕНИЕ: ' +
                (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
        }
    });

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/' });

    await waitFor('!!document.getElementById("login-form") && typeof window.switchTab === "function"');

    // ---- вход (мок-сессия) ----
    await evaluate(`(() => {
        document.getElementById('login-email').value = 'test@example.com';
        document.getElementById('login-password').value = 'secret123';
        document.getElementById('login-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        return true;
    })()`);

    const loggedIn = await waitFor(`(() => {
        const app = document.getElementById('app-container');
        return !!app && !app.classList.contains('hidden');
    })()`);
    log((loggedIn ? '  ok   ' : '  FAIL ') + 'вход выполнен (мок-сессия)');
    if (!loggedIn) failed += 1;

    const ok = (name, cond, extra = '') => {
        log((cond ? '  ok   ' : '  FAIL ') + name + (extra ? ' :: ' + extra : ''));
        if (!cond) failed += 1;
    };

    // ---- 1. Раздел «Снабжение»: список заявок ----
    requests.length = 0;
    await pageAction("window.switchTab('orders');", 2000);

    await waitFor(`(() => {
        const state = ${LIST_STATE};
        return state.cards > 0 && state.range.indexOf('из') !== -1;
    })()`);

    const page1 = await evaluate(LIST_STATE);
    const get1 = lastOrdersGet();

    ok('раздел «Снабжение» открылся и показал первую страницу списка',
        page1.cards === 25,
        'карточек: ' + page1.cards + ' (страница 25)');

    ok('запрос списка — страничный: offset=0, limit=25 и запрос общего числа (count=exact)',
        get1.offset === '0' && get1.limit === '25' && get1.prefer.includes('count=exact'),
        'offset: "' + get1.offset + '", limit: "' + get1.limit + '", Prefer: "' + get1.prefer + '"');

    ok('фильтр вкладки ушёл в запрос: status=in.(new,in_progress)',
        decodeURIComponent(get1.target).includes('status=in.(new,in_progress)'),
        decodeURIComponent(get1.target).slice(-160));

    ok('надпись панели берёт общее число из базы: «Показано 1-25 из 35»',
        page1.range.includes('1-25') && page1.range.includes('35'),
        '«' + page1.range + '»');

    ok('на первой странице «‹ Назад» выключена, а «Вперёд ›» доступна',
        page1.prevDisabled === true && page1.nextDisabled === false);

    // ---- 2. Ни одного запроса без ограничения: «выгрузи всё» больше нет ----
    const unbounded = ordersGets().filter((get) => !get.limit || Number(get.limit) > 100);
    ok('ни один запрос /orders не выгружает таблицу целиком (у всех есть limit)',
        unbounded.length === 0 && ordersGets().length > 0,
        unbounded.map((get) => get.target.slice(0, 80)).join(' | ') ||
            'запросов: ' + ordersGets().length + ', у всех limit <= 100');

    // ---- 3. Вторая страница: 26-35 и другие заявки ----
    await pageAction("document.getElementById('orders-next').click();");

    const page2 = await evaluate(LIST_STATE);
    const get2 = lastOrdersGet();
    const sameNumbers = page1.numbers.some((number) => page2.numbers.includes(number));

    ok('«Вперёд ›» открывает вторую страницу (26-35) и показывает ДРУГИЕ заявки',
        page2.cards === 10 && page2.range.includes('26-35') && !sameNumbers,
        'карточек: ' + page2.cards + ', «' + page2.range + '», offset=' + get2.offset + ', limit=' + get2.limit);

    ok('вторая страница запрошена смещением (offset=25, limit=25), а не перебором первой',
        get2.offset === '25' && get2.limit === '25',
        'offset=' + get2.offset + ', limit=' + get2.limit);

    ok('на последней странице «Вперёд ›» выключена',
        page2.nextDisabled === true && page2.prevDisabled === false);

    // ---- 4. Поиск: условие уходит в запрос ----
    requests.length = 0;
    await pageAction(`const search = document.getElementById('orders-search');
        search.value = 'трубы';
        search.dispatchEvent(new Event('input', { bubbles: true }));`, 1800);

    const searchState = await evaluate(LIST_STATE);
    const searchGet = lastOrdersGet();

    ok('поиск уходит условием or=(...ilike...), а не фильтрует выгруженное в браузере',
        decodeURIComponent(searchGet.target)
            .includes('or=(request_number.ilike.%трубы%,supplier.ilike.%трубы%)'),
        decodeURIComponent(searchGet.target).slice(-160));

    ok('поиск вернул только подходящие заявки (3 из 60) и снова с первой страницы',
        searchState.cards === 3 && searchState.range.includes('из 3'),
        'карточек: ' + searchState.cards + ', «' + searchState.range + '»');

    // ---- 5. Вкладка статуса: тоже условие запроса ----
    // Поиск очищаем как сотрудник: он остаётся заполненным при смене вкладки
    // (это нормально — но с текстом «трубы» закрытых заявок просто нет).
    await pageAction(`const search = document.getElementById('orders-search');
        search.value = '';
        search.dispatchEvent(new Event('input', { bubbles: true }));`, 1800);

    requests.length = 0;
    await pageAction("window.switchOrdersTab('closed');", 1500);

    const closedState = await evaluate(LIST_STATE);
    const closedGet = lastOrdersGet();

    ok('вкладка «🟢 Закрытые» — условие status=eq.closed в запросе',
        decodeURIComponent(closedGet.target).includes('status=eq.closed'),
        decodeURIComponent(closedGet.target).slice(0, 160));

    ok('после смены вкладки поиск сброшен и показаны все 10 закрытых заявок',
        closedState.range.includes('1-10') && closedState.range.includes('из 10') &&
        !decodeURIComponent(closedGet.target).includes('ilike'),
        '«' + closedState.range + '»');

    log('  всего запросов к базе за последний шаг: ' + requests.length);
    log('  ошибки в консоли: ' + (consoleErrors.length ? '\n    ' + consoleErrors.join('\n    ') : 'нет'));
    log('--- ИТОГ ---');
    log(failed === 0
        ? '  ВСЁ ВЕРНО: список читается страницами, фильтры и поиск — на сервере'
        : '  не прошло проверок: ' + failed);
} catch (error) {
    log('ОШИБКА ПРОГОНА: ' + (error && error.stack ? error.stack : error));
    failed += 1;
} finally {
    try { if (chrome) chrome.kill(); } catch { }
    try { server.close(); } catch { }
    const outDir = path.join(os.tmpdir(), 'rsk-fin');
    try {
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(path.join(outDir, 'scale-check.txt'), report.join('\r\n'), 'utf8');
    } catch { /* нет доступа к %TEMP% — отчёт остаётся в консоли */ }
    process.exit(failed === 0 ? 0 : 1);
}
