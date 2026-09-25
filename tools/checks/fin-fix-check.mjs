// =====================================================================
// Почему не сохраняется заявка — воспроизведение в браузере.
// Приложение отдаётся с локального сервера, «Supabase» подменён моком,
// поэтому видно, что именно делает интерфейс при разных ответах базы.
//
// С v2.8.0 заявку создаёт БАЗА одной командой (RPC), поэтому мок отвечает
// вместо create_cash_request_with_items / create_order_with_items, а прямой
// INSERT в orders и cash_requests отклоняет, как и боевая база (revoke insert).
//
// Сценарии (переменная окружения SCENARIO):
//   A — команда выполнена (200 + объект)            → ожидаем успех;
//   B — база отклонила по правам (403 + 42501)      → ожидаем понятную ошибку;
//   C — база ответила 200 без тела (пустой ответ)   → проверяем, не зависает ли UI.
// Поток: FLOW=finance — заявка на работы, FLOW=order — заявка на материалы.
// =====================================================================
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Корень приложения. По умолчанию — на две папки выше самого файла
// (tools/checks → корень репозитория). Можно переопределить: APP_ROOT=...
const ROOT = process.env.APP_ROOT
    ? path.resolve(process.env.APP_ROOT)
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 8123;
const CDP_PORT = 9337;
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
// Профиль Chrome. Папку прошлого прогона на Windows может не отпустить
// система: процессы Chrome (renderer, crashpad) живут ещё несколько секунд
// после kill, и rmSync падает с EPERM. Поэтому при отказе удаления берём
// отдельную папку для этого прогона — прогон не должен падать из-за профиля.
function prepareProfile(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
        return dir;
    } catch {
        const fallback = dir + '-' + process.pid;
        console.log('  профиль Chrome занят (' + dir + ') — использую ' + fallback);
        return fallback;
    }
}

let PROFILE = path.join(os.tmpdir(), 'rsk-fin', 'chrome-profile');
const SCENARIO = process.env.SCENARIO || 'A';
const FLOW = process.env.FLOW || 'finance';   // 'finance' — заявка на работы, 'order' — на материалы

const USER_ID = '11111111-1111-4111-8111-111111111111';
const EMPLOYEE = {
    id: 7, name: 'Тест Прораб', position: 'Прораб', phone: '+380000000000',
    status: 'active', user_id: USER_ID, notes: null, created_at: '2026-01-01T00:00:00Z'
};
const PROJECT = { id: 3, name: 'Тестовый объект' };
const SECTION = { id: 5, name: 'Кладочные работы', project_id: 3 };

const requests = [];
const createdCashRequests = [];
const createdOrders = [];
const createdOrderItems = [];
// Прямые INSERT в orders и cash_requests база с v2.8.0 отклоняет (revoke insert):
// сюда попадает всё, что приложение пишет в них напрямую, и валит прогон.
const directInserts = [];
const report = [];
const log = (...a) => { const line = a.join(' '); report.push(line); console.log(line); };

// Счётчик непройденных проверок. Объявлен на уровне модуля, потому что его
// читает блок finally — им задаётся код возврата прогона (1 = есть замечания).
let failed = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------- мок Supabase -------------------------------
function sendJson(res, status, payload, extraHeaders = {}) {
    const text = payload === undefined || payload === null ? '' : JSON.stringify(payload);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
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

// -------------------- серверные команды (RPC, v2.8.0) --------------------
// Заявку создаёт БАЗА одной командой: прямой INSERT в orders и cash_requests
// закрыт (revoke insert), поэтому приложение зовёт create_*_with_items.
// Ответы повторяют PostgREST: успех — JSON-объект, отказ — тело с кодом.
const YEAR_SHORT = String(new Date().getFullYear()).slice(-2);
const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

// Номер заявки база присваивает сама под блокировкой («№ N/YY», «Ф-N/YY»).
// В моке — максимум по текущему году + 1, как в migrate-v2.8-finance-rpc-audit.sql.
function nextNumber(prefix, numbers) {
    const pattern = new RegExp('^' + prefix + '([0-9]+)/' + YEAR_SHORT + '$');
    const max = numbers.reduce((acc, value) => {
        const parts = pattern.exec(String(value || ''));
        return parts ? Math.max(acc, Number(parts[1])) : acc;
    }, 0);
    return prefix + (max + 1) + '/' + YEAR_SHORT;
}

function handleRpc(fnName, body, res) {
    const params = JSON.parse(body || '{}');
    log('    [мок] RPC ' + fnName + ' (' + SCENARIO + ') ' + JSON.stringify(params).slice(0, 200));

    // Сценарий B: база отклонила команду по правам (нет роли / не применены
    // политики RLS). PostgREST отвечает телом с кодом 42501.
    if (SCENARIO === 'B') {
        return sendJson(res, 403, {
            code: '42501', message: 'permission denied for function ' + fnName,
            details: null, hint: null
        });
    }
    // Сценарий C: база ответила 200, но без тела — итог транзакции неизвестен.
    if (SCENARIO === 'C') {
        log('    [мок] RPC ответила 200 с пустым телом (итог транзакции неизвестен)');
        return sendJson(res, 200, null);
    }

    if (fnName === 'create_cash_request_with_items') {
        const items = Array.isArray(params.p_items) ? params.p_items : [];
        const totalSum = round2(items.reduce((sum, it) => sum + round2(it.qty) * round2(it.unit_price), 0));
        const requestNumber = nextNumber('Ф-', createdCashRequests);
        createdCashRequests.push(requestNumber);
        log('    [мок] RPC create_cash_request_with_items → ' + requestNumber +
            ' на ' + totalSum + ' (' + items.length + ' поз., номер присвоила база)');
        return sendJson(res, 200, {
            request_id: 42 + createdCashRequests.length - 1,
            request_number: requestNumber,
            status: 'pending',
            total_sum: totalSum,
            items_count: items.length
        });
    }

    if (fnName === 'create_order_with_items') {
        const items = Array.isArray(params.p_items) ? params.p_items : [];
        const requestNumber = nextNumber('№ ', createdOrders);
        createdOrders.push(requestNumber);
        // Позиции заявки на материалы база хранит без цен и без статуса оплаты:
        // заявка ещё не оплачена (на этом стоит проверка ниже).
        createdOrderItems.push(...items.map((it) => ({
            order_id: 77 + createdOrders.length - 1,
            name: it.name, unit: it.unit, qty: it.qty
        })));
        log('    [мок] RPC create_order_with_items → ' + requestNumber +
            ' (' + items.length + ' поз., номер присвоила база)');
        return sendJson(res, 200, {
            order_id: 77 + createdOrders.length - 1,
            request_number: requestNumber,
            status: 'new',
            items_count: items.length
        });
    }

    log('    [мок] неизвестная серверная команда: ' + fnName);
    return sendJson(res, 400, {
        code: 'PGRST202', message: 'Could not find the function public.' + fnName,
        details: null, hint: null
    });
}

function handleMock(req, res, body) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;
    const q = url.search;

    requests.push({ method: req.method, target: p + q, body: body || '' });

    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*' }); res.end(); return; }

    // ---- Auth ----
    if (p.includes('/auth/v1/token')) return sendJson(res, 200, SESSION);
    if (p.includes('/auth/v1/user')) return sendJson(res, 200, SESSION.user);
    if (p.includes('/auth/v1/logout')) return sendJson(res, 204, null);

    // ---- Серверные команды (RPC, v2.8.0) ----
    if (p.includes('/rest/v1/rpc/')) return handleRpc(p.split('/rest/v1/rpc/')[1], body, res);

    // ---- employees (нужен для входа и прав) ----
    if (p.includes('/rest/v1/employees')) {
        if (req.method === 'HEAD') {
            res.writeHead(200, {
                'Content-Range': '0-0/1', 'Access-Control-Allow-Origin': '*',
                'Access-Control-Expose-Headers': 'Content-Range'
            });
            res.end();
            return;
        }
        // supabase-js в .maybeSingle() ждёт ОБЪЕКТ: при массиве он сам вернёт
        // ошибку PGRST116 и data=null (тогда роль в приложении потерялась бы)
        if (req.url.includes('user_id=eq.')) return sendJson(res, 200, EMPLOYEE);
        return sendJson(res, 200, [EMPLOYEE]);
    }

    if (p.includes('/rest/v1/projects')) return sendJson(res, 200, [PROJECT]);
    if (p.includes('/rest/v1/sections')) return sendJson(res, 200, [SECTION]);
    if (p.includes('/rest/v1/cash_request_items')) {
        if (req.method === 'POST') return sendJson(res, 201, [{ id: 1, ...JSON.parse(body || '[{}]')[0] }]);
        return sendJson(res, 200, []);
    }

    // Номера созданных заявок возвращает серверная команда; мок их помнит и
    // отдаёт на чтение — так же, как это сделала бы база.
    if (p.includes('/rest/v1/cash_requests') && req.method === 'GET') {
        log('    [мок] GET cash_requests → отдаю номера ' + JSON.stringify(createdCashRequests));
        return sendJson(res, 200, createdCashRequests.map((n) => ({ request_number: n })));
    }
    if (p.includes('/rest/v1/orders') && req.method === 'GET') {
        return sendJson(res, 200, createdOrders.map((n) => ({ request_number: n })));
    }

    // ---- Прямая запись заявки: база её запрещает (revoke insert) ----
    // Раньше приложение само вставляло заявку в таблицу. С v2.8.0 это делает
    // серверная команда, а прямой INSERT база отклоняет — мок отвечает так же,
    // чтобы возврат к старой схеме был виден сразу (проверка в конце прогона).
    if (req.method === 'POST' && (p.includes('/rest/v1/cash_requests') || p.includes('/rest/v1/orders'))) {
        const table = p.includes('/rest/v1/orders') ? 'orders' : 'cash_requests';
        directInserts.push('POST ' + p + ' ' + String(body || '').slice(0, 140));
        log('    [мок] ⚠ ПРЯМАЯ ЗАПИСЬ в ' + table + ' — база отвечает отказом (revoke insert)');
        return sendJson(res, 403, {
            code: '42501', message: 'permission denied for table ' + table,
            details: null, hint: null
        });
    }

    // ---- Позиции заявки на материалы ----
    // Через прямую запись позиции приложение больше не пишет: их создаёт
    // команда create_order_with_items (см. handleRpc). Ветка оставлена, чтобы
    // старая схема была видна в отчёте.
    if (p.includes('/rest/v1/order_items') && req.method === 'POST') {
        const payload = JSON.parse(body || '{}');
        createdOrderItems.push(...(Array.isArray(payload) ? payload : [payload]));
        log('    [мок] ⚠ позиции заявки пишутся напрямую — их должна создать серверная команда');
        return sendJson(res, 201, payload);
    }

    // ---- Всё остальное: пустые чтения и успешные записи-заглушки ----
    if (req.method === 'GET' || req.method === 'HEAD') {
        if (req.method === 'HEAD') {
            res.writeHead(200, {
                'Content-Range': '*/0', 'Access-Control-Allow-Origin': '*',
                'Access-Control-Expose-Headers': 'Content-Range'
            });
            res.end();
            return;
        }
        return sendJson(res, 200, []);
    }
    return sendJson(res, 201, { id: 1, ...(body ? JSON.parse(body) : {}) });
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

        // В прогоне мок стоит на 127.0.0.1 — service worker считает его обычным
        // файлом и кэширует GET-ответы. Отключаем SW, чтобы читать свежие данные.
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
        throw new Error('ошибка в странице: ' + JSON.stringify(result.exceptionDetails.exception?.description || result.exceptionDetails.text));
    }
    return result.result.value;
}

const getJson = async (url) => (await fetch(url)).json();

// --------------------------------- прогон ---------------------------------
let chrome;
try {
    await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
    log('Сценарий: ' + SCENARIO + ' | приложение: http://127.0.0.1:' + PORT + ' (Supabase → мок)');

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
        if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
            consoleErrors.push(msg.params.type + ': ' + msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
        }
        if (msg.method === 'Runtime.exceptionThrown') {
            consoleErrors.push('ИСКЛЮЧЕНИЕ: ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
        }
    });

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/' });

    for (let i = 0; i < 60; i++) {
        const ready = await evaluate('!!document.getElementById("login-form") && typeof window.openNewCashRequestForm === "function"');
        if (ready) break;
        await sleep(250);
    }

    // ---- вход (мок-сессия) ----
    await evaluate(`(() => {
        document.getElementById('login-email').value = 'test@example.com';
        document.getElementById('login-password').value = 'secret123';
        document.getElementById('login-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        return true;
    })()`);

    let loggedIn = false;
    for (let i = 0; i < 80; i++) {
        const state = await evaluate(`(() => {
            const app = document.getElementById('app-container');
            return { app: !!app && !app.classList.contains('hidden'),
                     loginError: (document.getElementById('login-error') || {}).textContent || '' };
        })()`);
        if (state.app) { loggedIn = true; break; }
        await sleep(250);
    }
    log((loggedIn ? '  ok   ' : '  FAIL ') + 'вход выполнен (мок-сессия)');

    // ---- две попытки подряд: проверяем, что кнопка не «залипает» ----
    const fillAndSubmit = async () => {
        if (FLOW === 'finance') {
            await evaluate('window.openNewCashRequestForm()');
            await sleep(400);
            await evaluate(`(() => {
                const project = document.getElementById('new-cashreq-project');
                project.value = '3';
                project.dispatchEvent(new Event('change', { bubbles: true }));
                return true;
            })()`);
            await sleep(400);
            await evaluate(`(() => {
                const pick = (sel, value) => {
                    const el = document.querySelector(sel);
                    el.value = value;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                };
                document.getElementById('new-cashreq-section').value = '5';
                pick('.cashreq-item-name', 'Кладка стен газобетонных');
                pick('.cashreq-item-qty', '100');
                pick('.cashreq-item-price', '250');
                window.recalcCashRequestTotal();
                return true;
            })()`);
            await evaluate('document.querySelector(\'#new-cashreq-form button[type="submit"]\').click()');
            return;
        }

        await evaluate('window.openNewOrderForm()');
        await sleep(600);
        await evaluate(`(() => {
            const project = document.getElementById('new-order-project');
            project.value = '3';
            project.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        })()`);
        await sleep(400);
        await evaluate(`(() => {
            const pick = (sel, value) => {
                const el = document.querySelector(sel);
                el.value = value;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
            };
            document.getElementById('new-order-section').value = '5';
            pick('.order-item-name', 'Цемент М400');
            pick('.order-item-qty', '20');
            window.recalcOrderTotal();
            return true;
        })()`);
        await evaluate('document.querySelector(\'#new-order-form button[type="submit"]\').click()');
    };

    const formId = FLOW === 'finance' ? '#new-cashreq-form' : '#new-order-form';
    // Заявку создаёт серверная команда: её и считаем «отправленным запросом».
    const target = FLOW === 'finance'
        ? '/rest/v1/rpc/create_cash_request_with_items'
        : '/rest/v1/rpc/create_order_with_items';
    const stateExpr = `(() => {
        const btn = document.querySelector('${formId} button[type="submit"]');
        const toasts = [...document.body.children]
            .filter((el) => typeof el.className === 'string' && el.className.includes('z-[200]'))
            .map((el) => el.textContent.trim());
        return { btn: btn.textContent.trim(), disabled: btn.disabled, toasts };
    })()`;

    const attempts = [];
    for (let n = 1; n <= 2; n += 1) {
        const postsBefore = requests.filter((r) => r.method === 'POST' && r.target.includes(target)).length;

        await fillAndSubmit();

        let state = null;
        for (let i = 0; i < 12; i += 1) {
            await sleep(400);
            state = await evaluate(stateExpr);
            const postsNow = requests.filter((r) => r.method === 'POST' && r.target.includes(target)).length;
            if (postsNow > postsBefore && !state.disabled) break;
        }

        const sent = requests.filter((r) => r.method === 'POST' && r.target.includes(target)).length - postsBefore;
        const done = state.toasts.some((t) => t.includes('создана'));
        attempts.push({ n, sent, ...state, done });

        log('  попытка ' + n + ': запросов отправлено=' + sent +
            ', кнопка="' + state.btn + '" disabled=' + state.disabled +
            ', уведомление о создании=' + done + ', уведомления=' + JSON.stringify(state.toasts));
    }

    log('--- ИТОГ (' + FLOW + ', после исправления) ---');
    // failed объявлен на уровне модуля — из него берётся код возврата в finally.
    const ok = (name, cond, extra = '') => {
        log((cond ? '  ok   ' : '  FAIL ') + name + (extra ? ' :: ' + extra : ''));
        if (!cond) failed += 1;
    };

    attempts.forEach((a) => {
        ok('попытка ' + a.n + ': заявка отправлена в базу', a.sent === 1, 'запросов: ' + a.sent);
        ok('попытка ' + a.n + ': кнопка вернулась в рабочее состояние',
            a.disabled === false && a.btn === '💾 Создать заявку', 'кнопка="' + a.btn + '", disabled=' + a.disabled);

        // Сценарий A — база приняла команду. B (нет прав) и C (пустой ответ) —
        // заявки нет, но сотрудник должен получить понятное объяснение, а не
        // «зависшую» кнопку.
        const explained = a.toasts.some((t) => t.includes('Не удалось создать заявку'));
        ok('попытка ' + a.n + ': ' + (SCENARIO === 'A' ? 'показано подтверждение' : 'объяснена причина отказа'),
            SCENARIO === 'A' ? a.done === true : (!a.done && explained),
            'уведомления=' + JSON.stringify(a.toasts));
    });

    // Заявки создаёт только серверная команда: прямой INSERT база отклоняет.
    ok('заявка создаётся серверной командой, а не прямой записью в таблицу',
        directInserts.length === 0, directInserts.join(' | '));

    if (FLOW === 'order') {
        // Регрессия (жалоба «в карточке новой заявки стоит “Оплачено”»): новая
        // заявка ещё не оплачена, поэтому в позициях не должно быть payment_status.
        ok('в новых позициях нет статуса оплаты (заявка ещё не оплачена)',
            createdOrderItems.length > 0 && createdOrderItems.every((item) => item.payment_status === undefined),
            JSON.stringify(createdOrderItems));
    }

    log('  ИТОГО: ' + (failed === 0
        ? (SCENARIO === 'A'
            ? 'ВСЁ ВЕРНО — обе заявки ушли, кнопка не залипает'
            : 'ВСЁ ВЕРНО — отказ базы объяснён сотруднику, кнопка не залипает')
        : failed + ' проверок не прошло'));

    log('  созданные заявки в моке: ' + JSON.stringify(FLOW === 'finance' ? createdCashRequests : createdOrders) +
        ' (номер присваивает база, в браузере он не считается)');
    log('  записи приложения в базу: ' +
        JSON.stringify(requests.filter((r) => r.method !== 'GET' && r.method !== 'OPTIONS')
            .map((r) => r.method + ' ' + r.target.split('?')[0] +
                (r.body ? ' ' + String(r.body).slice(0, 70) : ''))));
    log('  прямых записей в orders/cash_requests (база их запрещает): ' +
        (directInserts.length ? directInserts.join(' | ') : 'нет'));
    log('  ошибки/исключения в консоли: ' + (consoleErrors.length ? '\n    ' + consoleErrors.join('\n    ') : 'нет'));
} catch (error) {
    log('ОШИБКА ПРОГОНА: ' + (error && error.stack ? error.stack : error));
    failed += 1;
} finally {
    try { if (chrome) chrome.kill(); } catch { /* уже закрыт */ }
    try { server.close(); } catch { /* сервер уже закрыт */ }
    const outDir = path.join(os.tmpdir(), 'rsk-fin');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'fin-fix-' + (process.env.FLOW || 'finance') + '.txt'), report.join('\r\n'), 'utf8');
    // Код возврата 1, если есть непройденные проверки (удобно для автоматики).
    process.exit(failed === 0 ? 0 : 1);
}

