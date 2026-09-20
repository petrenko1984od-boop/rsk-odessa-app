// =====================================================================
// Почему не сохраняется заявка финансов — воспроизведение в браузере.
// Приложение отдаётся с локального сервера, «Supabase» подменён моком,
// поэтому видно, что именно делает интерфейс при разных ответах базы.
//
// Сценарии (переменная окружения SCENARIO):
//   A — база приняла запись (201 + строка)          → ожидаем успех;
//   B — RLS не пускает (401 + 42501)                → ожидаем понятную ошибку;
//   C — база ответила 201 без тела (пустой ответ)   → проверяем, не зависает ли UI.
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
const PROFILE = path.join(os.tmpdir(), 'rsk-fin', 'chrome-profile');
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
const report = [];
const log = (...a) => { const line = a.join(' '); report.push(line); console.log(line); };
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

    // Номера выданных заявок: приложение считает следующий номер от максимума,
    // поэтому мок запоминает созданное и отдаёт это на чтение.
    if (p.includes('/rest/v1/cash_requests') && req.method === 'GET') {
        log('    [мок] GET cash_requests → отдаю номера ' + JSON.stringify(createdCashRequests));
        return sendJson(res, 200, createdCashRequests.map((n) => ({ request_number: n })));
    }
    if (p.includes('/rest/v1/orders') && req.method === 'GET') {
        return sendJson(res, 200, createdOrders.map((n) => ({ request_number: n })));
    }

    // ---- Сохранение заявки финансов ----
    if (p.includes('/rest/v1/cash_requests') && req.method === 'POST') {
        const payload = JSON.parse(body || '{}');
        createdCashRequests.push(payload.request_number);
        return sendJson(res, 201, { id: 42 + createdCashRequests.length - 1, ...payload });
    }

    // ---- Сохранение заявки на материалы ----
    if (p.includes('/rest/v1/orders') && req.method === 'POST') {
        const payload = JSON.parse(body || '{}');
        createdOrders.push(payload.request_number);
        return sendJson(res, 201, { id: 77 + createdOrders.length - 1, ...payload });
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

    fs.rmSync(PROFILE, { recursive: true, force: true });
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
    const target = FLOW === 'finance' ? '/cash_requests' : '/orders';
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
    let failed = 0;
    const ok = (name, cond, extra = '') => {
        log((cond ? '  ok   ' : '  FAIL ') + name + (extra ? ' :: ' + extra : ''));
        if (!cond) failed += 1;
    };

    attempts.forEach((a) => {
        ok('попытка ' + a.n + ': заявка отправлена в базу', a.sent === 1, 'запросов: ' + a.sent);
        ok('попытка ' + a.n + ': кнопка вернулась в рабочее состояние',
            a.disabled === false && a.btn === '💾 Создать заявку', 'кнопка="' + a.btn + '", disabled=' + a.disabled);
        ok('попытка ' + a.n + ': показано подтверждение', a.done === true);
    });

    log('  ИТОГО: ' + (failed === 0 ? 'ВСЁ ВЕРНО — обе заявки ушли, кнопка не залипает' : failed + ' проверок не прошло'));

    log('  созданные заявки в моке: ' + JSON.stringify(FLOW === 'finance' ? createdCashRequests : createdOrders));
    log('  запросы приложения к нужной таблице: ' +
        JSON.stringify(requests.filter((r) => r.target.includes(target) || r.target.includes('request_number')).map((r) => r.method + ' ' + r.target.split('?')[0] + (r.body ? ' ' + String(r.body).slice(0, 60) : ''))));
    log('  ошибки/исключения в консоли: ' + (consoleErrors.length ? '\n    ' + consoleErrors.join('\n    ') : 'нет'));
} catch (error) {
    log('ОШИБКА ПРОГОНА: ' + (error && error.stack ? error.stack : error));
} finally {
    try { if (chrome) chrome.kill(); } catch {}
    try { server.close(); } catch {}
    const outDir = path.join(os.tmpdir(), 'rsk-fin');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'fin-fix-' + (process.env.FLOW || 'finance') + '.txt'), report.join('\r\n'), 'utf8');
    process.exit(0);
}

