// =====================================================================
// Прогон нового согласования заявок на финансирование (v2.2.0) в браузере:
//   прораб создаёт → директор (одобрить / на доработку / отклонить)
//   → финансист выдаёт «Выдано» (сумма уходит с ЕГО подотчёта получателю).
// Приложение отдаётся с локального сервера, «Supabase» подменён моком,
// поэтому видно, что реально делает интерфейс и какие строки пишутся в базу.
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
const PORT = 8124;
const CDP_PORT = 9338;
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PROFILE = path.join(os.tmpdir(), 'rsk-fin', 'chrome-profile-workflow');
const BASE = 'http://127.0.0.1:' + PORT;

const USER_IDS = {
    7: '11111111-1111-4111-8111-111111111111',
    8: '22222222-2222-4222-8222-222222222222',
    9: '33333333-3333-4333-8333-333333333333'
};
const EMPLOYEE_BASE = { status: 'active', phone: null, notes: null, created_at: '2026-01-01T00:00:00Z' };

// ---------------------------------- «база» ----------------------------------
const store = {
    currentEmployeeId: 7,
    employees: [
        { ...EMPLOYEE_BASE, id: 7, name: 'Тест Прораб', position: 'Прораб', user_id: USER_IDS[7] },
        { ...EMPLOYEE_BASE, id: 8, name: 'Тест Директор', position: 'Директор', user_id: USER_IDS[8] },
        { ...EMPLOYEE_BASE, id: 9, name: 'Тест Финансист', position: 'Финансист', user_id: USER_IDS[9] }
    ],
    projects: [{ id: 3, name: 'Тестовый объект', foreman_id: 7 }],
    sections: [{ id: 5, name: 'Кладочные работы', project_id: 3, plan_total: 100000 }],
    cashRequests: [],
    cashRequestItems: [],
    cashOperations: [],
    nextRequestId: 101,
    nextItemId: 1001,
    nextOperationId: 5001
};

const requests = [];
const report = [];
const log = (...a) => { const line = a.join(' '); report.push(line); console.log(line); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const employee = (id) => store.employees.find((e) => e.id === id) || null;
const balanceOf = (id) => store.cashOperations
    .filter((op) => op.employee_id === id)
    .reduce((sum, op) => {
        const amount = Number(op.amount) || 0;
        if (op.operation_type === 'issue' || op.operation_type === 'adjustment') return sum + amount;
        if (op.operation_type === 'expense' || op.operation_type === 'return') return sum - amount;
        return sum;
    }, 0);

function sendJson(res, status, payload, extraHeaders = {}) {
    const text = payload === undefined || payload === null ? '' : JSON.stringify(payload);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': 'Content-Range',
        'Content-Range': '0-' + Math.max(0, (Array.isArray(payload) ? payload.length : 1) - 1) + '/*',
        ...extraHeaders
    });
    res.end(text);
}

const cashRequestRows = () => store.cashRequests.map((row) => {
    const project = store.projects.find((p) => p.id === row.project_id) || null;
    const section = store.sections.find((s) => s.id === row.section_id) || null;
    const author = employee(row.employee_id);
    const approver = employee(row.approved_by_employee_id);
    return {
        ...row,
        project: project ? { id: project.id, name: project.name } : null,
        section: section ? { id: section.id, name: section.name } : null,
        employee: author ? { id: author.id, name: author.name, position: author.position } : null,
        approver: approver ? { id: approver.id, name: approver.name } : null
    };
});

function rowsFor(table, params) {
    const byEq = (rows, column) => {
        const raw = params[column];
        if (!raw) return rows;
        return rows.filter((row) => String(row[column]) === String(raw).replace(/^eq\./, ''));
    };

    switch (table) {
        case 'employees': {
            let rows = store.employees.slice();
            rows = byEq(rows, 'user_id');
            rows = byEq(rows, 'id');
            rows = byEq(rows, 'position');
            return rows;
        }
        case 'projects': return store.projects;
        case 'sections': return store.sections;
        case 'cash_requests': return byEq(cashRequestRows(), 'id');
        case 'cash_request_items': return byEq(store.cashRequestItems, 'request_id');
        case 'cash_operations': {
            let rows = store.cashOperations.slice();
            rows = byEq(rows, 'operation_type');
            rows = byEq(rows, 'employee_id');
            return rows;
        }
        case 'employee_cash_balance': {
            const requested = params.employee_id ? [Number(String(params.employee_id).replace(/^eq\./, ''))] : store.employees.map((e) => e.id);
            return requested
                .map((id) => ({ employee_id: id, name: employee(id)?.name || '—', balance: balanceOf(id) }))
                .filter((row) => params.employee_id || true);
        }
        default: return [];
    }
}

// supabase-js ждёт ОБЪЕКТ (а не массив) для запросов с .maybeSingle():
// в 2.45.4 при массиве он сам возвращает ошибку PGRST116 и data=null.
// Определяем такие запросы по фильтру, а не по заголовку Accept.
function wantsSingleRow(table, params) {
    if (table === 'employees') return Boolean(params.user_id || params.id);
    if (table === 'employee_cash_balance') return Boolean(params.employee_id);
    return false;
}

// --------------------------------- мок Supabase ---------------------------------
function handleMock(req, res, body) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;
    const q = url.search;
    const params = Object.fromEntries(url.searchParams.entries());
    const wantsObject = String(req.headers.accept || '').includes('vnd.pgrst.object');
    const table = (p.match(/\/rest\/v1\/([a-z_]+)/) || [])[1] || null;
    const payload = body ? JSON.parse(body) : null;

    requests.push({ method: req.method, target: p + q, body: body || '' });

    if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' });
        res.end();
        return;
    }

    // ---- Auth ----
    if (p.includes('/auth/v1/token')) return sendJson(res, 200, session());
    if (p.includes('/auth/v1/user')) return sendJson(res, 200, session().user);
    if (p.includes('/auth/v1/logout')) return sendJson(res, 204, null);

    if (!table) return sendJson(res, 200, []);

    // ---- Чтение ----
    if (req.method === 'GET') {
        const rows = rowsFor(table, params);
        if (wantsObject || wantsSingleRow(table, params)) {
            if (!rows.length) {
                return sendJson(res, 406, {
                    code: 'PGRST116', details: 'Results contain 0 rows',
                    hint: null, message: 'JSON object requested, multiple (or no) rows returned'
                });
            }
            return sendJson(res, 200, rows[0]);
        }
        return sendJson(res, 200, rows);
    }

    if (req.method === 'POST') {
        const rows = Array.isArray(payload) ? payload : [payload];

        if (table === 'cash_requests') {
            const created = rows.map((row) => {
                const id = store.nextRequestId++;
                const record = {
                    id, created_at: new Date().toISOString(),
                    status: 'pending', rejection_reason: null,
                    approved_by_employee_id: null, approved_at: null,
                    issued_operation_id: null, ...row
                };
                store.cashRequests.push(record);
                log('    [мок] INSERT cash_requests #' + id + ' ' + record.request_number +
                    ' на ' + record.total_sum + ' (' + employee(record.employee_id)?.name + ')');
                return record;
            });
            return sendJson(res, 201, Array.isArray(payload) ? created : created[0]);
        }

        if (table === 'cash_request_items') {
            const created = rows.map((row) => {
                const record = { id: store.nextItemId++, ...row };
                store.cashRequestItems.push(record);
                return record;
            });
            return sendJson(res, 201, Array.isArray(payload) ? created : created[0]);
        }

        if (table === 'cash_operations') {
            const created = rows.map((row) => {
                const record = { id: store.nextOperationId++, created_at: new Date().toISOString(), operation_date: new Date().toISOString().slice(0, 10), ...row };
                store.cashOperations.push(record);
                log('    [мок] INSERT cash_operations ' + record.operation_type + ' ' + record.amount +
                    ' → ' + (employee(record.employee_id)?.name || record.employee_id) + ' :: ' + (record.description || ''));
                return record;
            });
            return sendJson(res, 201, Array.isArray(payload) ? created : created[0]);
        }

        return sendJson(res, 201, Array.isArray(payload) ? rows : rows[0]);
    }

    // ---- Обновление ----
    if (req.method === 'PATCH') {
        const idRaw = params.id;
        const ids = idRaw ? [Number(String(idRaw).replace(/^eq\./, ''))] : [];
        const updated = [];

        if (table === 'cash_requests') {
            store.cashRequests.forEach((row) => {
                if (ids.length && !ids.includes(row.id)) return;
                Object.assign(row, payload);
                updated.push(row);
                log('    [мок] UPDATE cash_requests #' + row.id + ' → status=' + row.status +
                    (row.rejection_reason ? ' (' + row.rejection_reason + ')' : ''));
            });
        }

        return sendJson(res, 200, updated.map((row) => ({ ...row })));
    }

    // ---- Удаление ----
    if (req.method === 'DELETE') {
        const requestIdRaw = params.request_id;
        if (table === 'cash_request_items' && requestIdRaw) {
            const requestId = Number(String(requestIdRaw).replace(/^eq\./, ''));
            const before = store.cashRequestItems.length;
            store.cashRequestItems = store.cashRequestItems.filter((row) => row.request_id !== requestId);
            log('    [мок] DELETE cash_request_items для заявки #' + requestId + ': ' + (before - store.cashRequestItems.length));
        }
        if (table === 'cash_requests' && params.id) {
            const id = Number(String(params.id).replace(/^eq\./, ''));
            store.cashRequests = store.cashRequests.filter((row) => row.id !== id);
            store.cashRequestItems = store.cashRequestItems.filter((row) => row.request_id !== id);
        }
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
        res.end();
        return;
    }

    return sendJson(res, 200, []);
}

// ---------------------------------- сессия ----------------------------------
// Сессия строится под ТЕКУЩУЮ роль: у каждого тестового сотрудника свой
// user_id, иначе приложение находило бы одного и того же «сотрудника».
const currentUserId = () => USER_IDS[store.currentEmployeeId];

function session() {
    const userId = currentUserId();
    return {
        access_token: 'header.' + Buffer.from(JSON.stringify({
            sub: userId, role: 'authenticated', email: 'test@example.com',
            exp: Math.floor(Date.now() / 1000) + 3600
        })).toString('base64url') + '.sig',
        token_type: 'bearer',
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        refresh_token: 'refresh-test',
        user: {
            id: userId, aud: 'authenticated', role: 'authenticated',
            email: 'test@example.com', app_metadata: {}, user_metadata: {},
            created_at: '2026-01-01T00:00:00Z'
        }
    };
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

    // SW выключен: на 127.0.0.1 мок выглядел бы обычными файлами и кэшировался
    if (urlPath === '/sw.js') {
        res.writeHead(200, { 'Content-Type': MIME['.js'] });
        res.end('// тестовый прогон: service worker выключен\n');
        return;
    }

    const file = urlPath.endsWith('/') ? path.join(ROOT, 'index.html') : path.join(ROOT, urlPath);
    fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); res.end('not found'); return; }

        let out = data;
        if (urlPath === '/js/config.js') {
            // Единственная правка: приложение ходит в мок, а не в боевую базу
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

async function waitFor(expression, tries = 40, pause = 300) {
    for (let i = 0; i < tries; i += 1) {
        try {
            if (await evaluate(expression)) return true;
        } catch { /* страница ещё грузится */ }
        await sleep(pause);
    }
    return false;
}



// ----------------------------------- прогон -----------------------------------
let chrome;
let failed = 0;
const ok = (name, cond, extra = '') => {
    log((cond ? '  ok   ' : '  FAIL ') + name + (extra ? ' :: ' + extra : ''));
    if (!cond) failed += 1;
};

const REQUEST_OF = (n) => store.cashRequests.find((r) => r.request_number === n) || null;

try {
    await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
    log('Прогон согласования заявок на финансирование: ' + BASE + ' (Supabase → мок)');

    fs.rmSync(PROFILE, { recursive: true, force: true });
    chrome = spawn(CHROME, [
        '--headless=new', '--remote-debugging-port=' + CDP_PORT,
        '--user-data-dir=' + PROFILE, '--no-first-run', '--no-default-browser-check',
        '--disable-extensions', '--window-size=1280,1000', 'about:blank'
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

    // Вход под нужной ролью: мок отдаёт того сотрудника, чей id выставлен
    const loginAs = async (employeeId, label) => {
        store.currentEmployeeId = employeeId;

        // Прошлую сессию убираем: приложение держит её в localStorage и при
        // перезагрузке подхватило бы роль предыдущего сотрудника.
        await send('Page.navigate', { url: BASE + '/?role=' + employeeId });
        await waitFor('!!document.getElementById("login-form") || !!document.getElementById("app-container")', 60);
        await evaluate('(() => { try { localStorage.clear(); } catch (e) { /* нет доступа */ } return true; })()');
        await send('Page.navigate', { url: BASE + '/?role=' + employeeId + '&t=' + Date.now() });
        await waitFor('!!document.getElementById("login-form") && typeof window.openNewCashRequestForm === "function"', 60);
        await evaluate('(() => {' +
            'document.getElementById("login-email").value = "test@example.com";' +
            'document.getElementById("login-password").value = "secret123";' +
            'document.getElementById("login-form").dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));' +
            'return true; })()');
        const done = await waitFor('(() => { const app = document.getElementById("app-container");' +
            ' return !!app && !app.classList.contains("hidden"); })()', 80);
        await sleep(900);
        log('--- ' + label + ' (сотрудник #' + employeeId + ') ---');
        ok('вход выполнен', done);
        return done;
    };

    const pickItem = async (name, qty, price) => {
        await evaluate('(() => {' +
            'const pick = (sel, val) => { const el = document.querySelector(sel); el.value = val; el.dispatchEvent(new Event("input", { bubbles: true })); };' +
            'pick(".cashreq-item-name", "' + name + '");' +
            'pick(".cashreq-item-qty", "' + qty + '");' +
            'pick(".cashreq-item-price", "' + price + '");' +
            'window.recalcCashRequestTotal();' +
            'return true; })()');
    };

    // Форма заявки: проект → раздел → позиция → сохранение
    const createRequest = async (name, qty, price) => {
        await evaluate('window.openNewCashRequestForm()');
        await sleep(500);
        await evaluate('(() => { const s = document.getElementById("new-cashreq-project");' +
            ' s.value = "3"; s.dispatchEvent(new Event("change", { bubbles: true })); return true; })()');
        await sleep(700);
        await evaluate('document.getElementById("new-cashreq-section").value = "5"');
        await pickItem(name, qty, price);
        await evaluate('document.querySelector("#new-cashreq-form button[type=\\"submit\\"]").click()');
        await sleep(1600);
    };

    // ---------------------- 1. Прораб создаёт заявки ----------------------
    await loginAs(7, 'Прораб');

    const blockText = async () => evaluate('(document.getElementById("dashboard-content") || {}).innerText || ""');
    let dash = await blockText();
    ok('на рабочем экране есть блок «Мои заявки на финансирование»', dash.includes('Мои заявки на финансирование'),
        dash.slice(0, 120).replace(/\n/g, ' | '));

    await createRequest('Кладка стен', 10, 500);
    const requestA = REQUEST_OF('Ф-1/26');
    ok('заявка Ф-1/26 создана (pending, 5 000)',
        !!requestA && requestA.status === 'pending' && Number(requestA.total_sum) === 5000,
        requestA ? 'status=' + requestA.status + ', сумма=' + requestA.total_sum : 'нет в базе');

    await sleep(600);
    dash = await blockText();
    ok('прораб видит свою заявку на дашборде', dash.includes('Ф-1/26'));
    ok('на дашборде указано, что заявка ждёт директора', dash.includes('На согласовании'));

    await createRequest('Кладка стен', 6, 500);
    const requestB = REQUEST_OF('Ф-2/26');
    ok('вторая заявка Ф-2/26 создана (3 000, pending)',
        !!requestB && requestB.status === 'pending' && Number(requestB.total_sum) === 3000,
        requestB ? 'status=' + requestB.status : 'нет в базе');

    // ---------------------- 2. Директор: три решения ----------------------
    await loginAs(8, 'Директор');
    await evaluate('window.switchTab("cash-requests")');
    await sleep(1400);

    const directorUi = await evaluate('(() => {' +
        'const vis = (id) => { const el = document.getElementById(id); return !!el && getComputedStyle(el).display !== "none"; };' +
        'return { topup: vis("btn-topup-financier"), create: vis("create-cash-request-btn"),' +
        ' hint: (document.getElementById("financier-balance-hint") || {}).innerText || "",' +
        ' hintVisible: vis("financier-balance-hint"),' +
        ' hintBeforeBtn: (() => { const h = document.getElementById("financier-balance-hint");' +
        '   const b = document.getElementById("btn-topup-financier");' +
        '   if (!h || !b || !h.parentElement) return null;' +
        '   return Array.prototype.indexOf.call(h.parentElement.children, h) <' +
        '     Array.prototype.indexOf.call(h.parentElement.children, b); })(),' +
        ' lists: (document.getElementById("cash-requests-container") || {}).innerText || "" }; })()');
    ok('у директора видна кнопка «Пополнить баланс финансиста»', directorUi.topup === true);
    ok('у директора нет кнопки «Создать заявку»', directorUi.create === false);
    ok('рядом с кнопкой виден актуальный баланс финансиста (сейчас 0)',
        directorUi.hintVisible === true && directorUi.hint.includes('Баланс финансиста') &&
        directorUi.hint.replace(/\s/g, '').includes('0,00') && directorUi.hintBeforeBtn === true,
        directorUi.hint.replace(/\n/g, ' | ') + ' :: перед кнопкой: ' + directorUi.hintBeforeBtn);
    ok('директор видит заявку прораба', directorUi.lists.includes('Ф-1/26'));

    const directorNav = await evaluate('(() => { const ids = ["btn-tasks", "btn-projects", "btn-employees", "btn-orders", "btn-cash-requests", "btn-registry"];' +
        ' const box = document.getElementById("btn-tasks").parentElement;' +
        ' return Array.prototype.filter.call(box.children,' +
        '   (el) => ids.indexOf(el.id) > -1 && getComputedStyle(el).display !== "none")' +
        '   .map((el) => el.id)[0] || ""; })()');
    ok('у директора порядок разделов в шапке прежний («Рабочий экран» первым)',
        directorNav === 'btn-tasks', directorNav);

    await evaluate('window.openCashRequestDetail(' + requestA.id + ')');
    await sleep(600);
    const actions = await evaluate('(document.getElementById("cash-request-detail-actions") || {}).innerText || ""');
    ok('у директора три кнопки: Одобрить / На доработку / Отклонить',
        actions.includes('Одобрить') && actions.includes('На доработку') && actions.includes('Отклонить'),
        actions.replace(/\n/g, ' | '));

    await evaluate('window.prompt = () => "Разбей сумму на две позиции"');
    await evaluate('document.getElementById("cash-request-detail-actions").querySelectorAll("button")[1].click()');
    await sleep(1600);
    ok('заявка вернулась автору: статус «На доработке» с причиной',
        requestA.status === 'revision' && requestA.rejection_reason === 'Разбей сумму на две позиции',
        'status=' + requestA.status + ', причина=' + requestA.rejection_reason);
    ok('решение директора записано (approved_by=8)', Number(requestA.approved_by_employee_id) === 8);

    // ---------------------- 3. Прораб дорабатывает заявку ----------------------
    await loginAs(7, 'Прораб');
    dash = await blockText();
    ok('прораб видит возврат на своём рабочем экране', dash.includes('Требует доработки'));
    ok('прораб видит причину возврата', dash.includes('Разбей сумму на две позиции'));
    ok('у прораба есть кнопка «Исправить и отправить»', dash.includes('Исправить и отправить'));

    await evaluate('window.openCashRequestEdit(' + requestA.id + ')');
    await sleep(1000);
    const editState = await evaluate('(() => ({' +
        'title: (document.getElementById("new-cashreq-modal-title") || {}).textContent || "",' +
        'hint: (document.getElementById("new-cashreq-revision-hint") || {}).textContent || "",' +
        'project: document.getElementById("new-cashreq-project").value,' +
        'section: document.getElementById("new-cashreq-section").value,' +
        'name: (document.querySelector(".cashreq-item-name") || {}).value || "",' +
        'qty: (document.querySelector(".cashreq-item-qty") || {}).value || "" }))()');
    ok('форма открылась в режиме доработки', editState.title.includes('Доработка заявки Ф-1/26'), editState.title);
    ok('в форме показана причина возврата', editState.hint.includes('Разбей сумму на две позиции'));
    ok('позиции заявки подставлены',
        editState.name === 'Кладка стен' && editState.qty === '10' && editState.project === '3' && editState.section === '5',
        JSON.stringify(editState));

    await pickItem('Кладка стен', 20, 500);
    await evaluate('document.querySelector("#new-cashreq-form button[type=\\"submit\\"]").click()');
    await sleep(1700);
    const itemsA = store.cashRequestItems.filter((row) => row.request_id === requestA.id);
    ok('после доработки заявка снова у директора (pending, 10 000)',
        requestA.status === 'pending' && Number(requestA.total_sum) === 10000 && !requestA.rejection_reason,
        'status=' + requestA.status + ', сумма=' + requestA.total_sum + ', причина=' + requestA.rejection_reason);
    ok('позиции перезаписаны, старая не осталась',
        itemsA.length === 1 && Number(itemsA[0].qty) === 20,
        'позиций: ' + itemsA.length + ', qty=' + (itemsA[0] || {}).qty);

    // ---------------------- 4. Директор одобряет ----------------------
    await loginAs(8, 'Директор');
    await evaluate('window.switchTab("cash-requests")');
    await sleep(1400);
    await evaluate('window.openCashRequestDetail(' + requestA.id + ')');
    await sleep(600);
    const approvedView = await evaluate('(document.getElementById("cash-request-detail-content") || {}).innerText || ""');
    ok('после доработки причина в карточке не висит', !approvedView.includes('Причина доработки'), approvedView.replace(/\n/g, ' | ').slice(0, 120));

    await evaluate('window.confirm = () => true');
    await evaluate('document.getElementById("cash-request-detail-actions").querySelectorAll("button")[0].click()');
    await sleep(1600);
    ok('директор одобрил заявку', requestA.status === 'approved', 'status=' + requestA.status);

    // ---------------------- 5. Пополнение подотчёта финансиста ----------------------
    await evaluate('window.openTopUpBalanceModal()');
    await sleep(1000);
    const topUpState = await evaluate('(() => ({' +
        'modal: !document.getElementById("topup-balance-modal").classList.contains("hidden"),' +
        'employee: document.getElementById("topup-balance-employee").value,' +
        'options: document.getElementById("topup-balance-employee").innerText }))()');
    ok('окно пополнения открылось и финансист выбран', topUpState.modal === true && topUpState.employee === '9',
        JSON.stringify(topUpState));

    await evaluate('(() => {' +
        'document.getElementById("topup-balance-amount").value = "10000";' +
        'document.getElementById("topup-balance-comment").value = "Передал наличными";' +
        'document.getElementById("topup-balance-form").dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));' +
        'return true; })()');
    await sleep(1600);
    const topUpOp = store.cashOperations.find((op) => op.employee_id === 9 && op.operation_type === 'issue');
    ok('подотчёт финансиста пополнен операцией issue (без объекта)',
        !!topUpOp && Number(topUpOp.amount) === 10000 && !topUpOp.project_id,
        topUpOp ? JSON.stringify({ type: topUpOp.operation_type, amount: topUpOp.amount, project: topUpOp.project_id }) : 'нет операции');
    ok('баланс финансиста = 10 000', balanceOf(9) === 10000, 'баланс: ' + balanceOf(9));

    const hintAfterTopUp = await evaluate('(document.getElementById("financier-balance-hint") || {}).innerText || ""');
    ok('баланс рядом с кнопкой пересчитался сразу после пополнения (10 000)',
        hintAfterTopUp.replace(/\s/g, '').includes('10000'), hintAfterTopUp.replace(/\n/g, ' | '));

    // ---------------------- 6. Финансист выдаёт деньги ----------------------
    await loginAs(9, 'Финансист');
    const finUi = await evaluate('(() => {' +
        'const vis = (id) => { const el = document.getElementById(id); return !!el && getComputedStyle(el).display !== "none"; };' +
        'return { tab: vis("tab-cash-requests"), title: (document.getElementById("cashreq-tab-title") || {}).textContent || "",' +
        ' navBtn: (document.getElementById("btn-cash-requests") || {}).textContent || "",' +
        ' navFirst: (() => { const ids = ["btn-tasks", "btn-projects", "btn-employees", "btn-orders", "btn-cash-requests", "btn-registry"];' +
        '   const box = document.getElementById("btn-tasks").parentElement;' +
        '   return Array.prototype.filter.call(box.children,' +
        '     (el) => ids.indexOf(el.id) > -1 && getComputedStyle(el).display !== "none")' +
        '     .map((el) => el.id)[0] || ""; })(),' +
        ' navLeft: (() => { const c = document.getElementById("btn-cash-requests");' +
        '   const p = document.getElementById("btn-projects");' +
        '   return Math.round(c.getBoundingClientRect().left) < Math.round(p.getBoundingClientRect().left); })(),' +
        ' hintVisible: vis("financier-balance-hint"),' +
        ' tasks: vis("btn-tasks"), orders: vis("btn-orders"), registry: vis("btn-registry"),' +
        ' employees: vis("btn-employees"), projects: vis("btn-projects"),' +
        ' create: vis("create-cash-request-btn"), topup: vis("btn-topup-financier"),' +
        ' panel: (document.getElementById("financier-balance-panel") || {}).innerText || "",' +
        ' lists: (document.getElementById("cash-requests-container") || {}).innerText || "" }; })()');
    ok('финансист попадает на свой рабочий стол', finUi.tab === true && finUi.title.includes('Рабочий стол финансиста'), finUi.title);
    ok('раздел в шапке называется «Рабочий стол»', finUi.navBtn.includes('Рабочий стол'), finUi.navBtn);
    ok('«Рабочий стол» — первая кнопка в шапке финансиста',
        finUi.navFirst === 'btn-cash-requests' && finUi.navLeft === true,
        finUi.navFirst + ' :: левее «Объектов»: ' + finUi.navLeft);
    ok('панель показывает «Мой баланс» с суммой 10 000',
        finUi.panel.toLowerCase().includes('мой баланс') && finUi.panel.replace(/\s/g, '').includes('10000'),
        finUi.panel.replace(/\n/g, ' | '));
    ok('в панели нет подсказки про кнопку директора', !finUi.panel.includes('Пополняет директор'),
        finUi.panel.replace(/\n/g, ' | '));
    ok('подсказки «баланс финансиста» финансист не видит', finUi.hintVisible === false);
    ok('разделы финансиста: Объекты, Сотрудники, Реестр — есть; Задачи и Снабжение — нет',
        finUi.projects && finUi.employees && finUi.registry && !finUi.tasks && !finUi.orders,
        JSON.stringify({ projects: finUi.projects, employees: finUi.employees, registry: finUi.registry, tasks: finUi.tasks, orders: finUi.orders }));
    ok('финансист ничего не создаёт и не пополняет', finUi.create === false && finUi.topup === false);
    ok('финансист видит одобренную заявку', finUi.lists.includes('Ф-1/26'));
    ok('финансист НЕ видит неодобренную заявку', !finUi.lists.includes('Ф-2/26'));

    // Рабочий стол финансиста = два блока: счета на материалы + одобренные заявки
    const finBlocks = await evaluate('(() => {' +
        'const vis = (id) => { const el = document.getElementById(id); return !!el && getComputedStyle(el).display !== "none"; };' +
        'return { invoices: vis("material-invoices-panel"),' +
        ' invoiceText: (document.getElementById("material-invoices-panel") || {}).innerText || "",' +
        ' invoiceTabs: (document.getElementById("invoice-tabs") || {}).innerText || "",' +
        ' invoiceExcel: vis("invoice-export-btn"),' +
        ' desk: vis("financier-desk-head"),' +
        ' deskText: (document.getElementById("financier-desk-head") || {}).innerText || "",' +
        ' blockHead: vis("financier-approved-head"),' +
        ' blockText: (document.getElementById("financier-approved-head") || {}).innerText || "",' +
        ' filters: vis("cashreq-filters"),' +
        ' tabs: Array.prototype.map.call(document.querySelectorAll("#financier-approved-head button"), (b) => b.id).join(",") }; })()');
    ok('рабочий стол финансиста собран в один блок «💰 Финансовые заявки»',
        finBlocks.desk === true && finBlocks.deskText.toLowerCase().includes('финансовые заявки'),
        finBlocks.deskText.replace(/\n/g, ' | ').slice(0, 160));
    ok('в блоке счетов — меню «⏳ Ожидают оплату / ✅ Оплаченные» и выгрузка в Excel',
        finBlocks.invoiceTabs.includes('Ожидают оплату') && finBlocks.invoiceTabs.includes('Оплаченные') &&
        finBlocks.invoiceExcel === true,
        finBlocks.invoiceTabs.replace(/\n/g, ' | ') + ' :: excel=' + finBlocks.invoiceExcel);
    ok('очередь 1 рабочего стола — «🧾 Счета на материалы»',
        finBlocks.invoices === true && finBlocks.invoiceText.includes('Счета на материалы'),
        finBlocks.invoiceText.replace(/\n/g, ' | ').slice(0, 140));
    ok('очередь 2 рабочего стола — «🟡 Одобренные заявки на выдачу»',
        finBlocks.blockHead === true && finBlocks.blockText.includes('Одобренные заявки на выдачу'),
        finBlocks.blockText.replace(/\n/g, ' | ').slice(0, 160));
    ok('общие фильтры заявок финансисту скрыты', finBlocks.filters === false,
        'cashreq-filters виден: ' + finBlocks.filters);
    ok('в очереди 2 два переключателя: «К выдаче» и «Выданные»',
        finBlocks.tabs === 'financier-view-approved,financier-view-issued', finBlocks.tabs);

    await evaluate('window.openCashRequestDetail(' + requestA.id + ')');
    await sleep(700);
    const finActions = await evaluate('(document.getElementById("cash-request-detail-actions") || {}).innerText || ""');
    ok('у финансиста только кнопка «Выдано»',
        finActions.includes('Выдано') && !finActions.includes('Одобрить') && !finActions.includes('Отклонить'),
        finActions.replace(/\n/g, ' | '));

    const opsBefore = store.cashOperations.length;
    await evaluate('window.confirm = () => true');
    await evaluate('document.getElementById("cash-request-detail-actions").querySelectorAll("button")[0].click()');
    await sleep(2000);

    const newOps = store.cashOperations.slice(opsBefore);
    const debit = newOps.find((op) => op.employee_id === 9 && op.operation_type === 'return');
    const credit = newOps.find((op) => op.employee_id === 7 && op.operation_type === 'issue');
    ok('заявка стала «Выдано»', requestA.status === 'issued', 'status=' + requestA.status);
    ok('получателю записан приход на 10 000', !!credit && Number(credit.amount) === 10000,
        credit ? JSON.stringify({ type: credit.operation_type, amount: credit.amount }) : 'нет операции');
    ok('с подотчёта финансиста списано 10 000', !!debit && Number(debit.amount) === 10000,
        debit ? JSON.stringify({ type: debit.operation_type, amount: debit.amount, desc: debit.description }) : 'нет операции');
    ok('баланс финансиста после выдачи = 0', balanceOf(9) === 0, 'баланс: ' + balanceOf(9));
    ok('баланс прораба после выдачи = 10 000', balanceOf(7) === 10000, 'баланс: ' + balanceOf(7));
    ok('выдача не попала в «Реестр» как трата',
        store.cashOperations.filter((op) => op.operation_type === 'expense').length === 0,
        'операций expense: ' + store.cashOperations.filter((op) => op.operation_type === 'expense').length);

    // Блок 2 рабочего стола: заявка ушла из «🟡 К выдаче» в «🟢 Выданные»
    const finAfterIssue = await evaluate('(() => ({' +
        ' head: (document.getElementById("financier-approved-head") || {}).innerText || "",' +
        ' list: (document.getElementById("cash-requests-container") || {}).innerText || "" }))()');
    ok('после выдачи список «🟡 К выдаче» опустел, счётчик стал 0',
        !finAfterIssue.list.includes('Ф-1/26') && finAfterIssue.head.includes('К выдаче (0)'),
        finAfterIssue.head.replace(/\n/g, ' | ') + ' :: ' + finAfterIssue.list.replace(/\n/g, ' | ').slice(0, 120));

    await evaluate('window.setFinancierView("issued")');
    await sleep(600);
    const finIssuedList = await evaluate('(document.getElementById("cash-requests-container") || {}).innerText || ""');
    ok('в «🟢 Выданные» видна выданная заявка со статусом «Выдано»',
        finIssuedList.includes('Ф-1/26') && finIssuedList.includes('Выдано'),
        finIssuedList.replace(/\n/g, ' | ').slice(0, 160));

    await evaluate('window.setFinancierView("approved")');
    await sleep(400);

    // ---------------------- 7. Директор отклоняет заявку ----------------------
    await loginAs(8, 'Директор');
    await evaluate('window.switchTab("cash-requests")');
    await sleep(1400);
    await evaluate('window.openCashRequestDetail(' + requestB.id + ')');
    await sleep(600);
    await evaluate('window.prompt = () => "Дублирует заявку Ф-1/26"');
    await evaluate('window.confirm = () => true');
    await evaluate('document.getElementById("cash-request-detail-actions").querySelectorAll("button")[2].click()');
    await sleep(1600);
    ok('директор отклонил заявку с причиной',
        requestB.status === 'rejected' && requestB.rejection_reason === 'Дублирует заявку Ф-1/26',
        'status=' + requestB.status + ', причина=' + requestB.rejection_reason);

    // ---------------------- 8. Прораб видит результат ----------------------
    await loginAs(7, 'Прораб');
    dash = await blockText();
    ok('прораб видит, что деньги выданы', dash.includes('Выдано') && dash.includes('Ф-1/26'));
    ok('отклонённая заявка ушла с рабочего экрана', !dash.includes('Ф-2/26'));

    log('--- ИТОГ ---');
    log(failed === 0 ? '  ВСЁ ВЕРНО: согласование, доработка, выдача и балансы сходятся' : '  не прошло проверок: ' + failed);
    log('  заявки в моке: ' + JSON.stringify(store.cashRequests.map((r) => ({
        number: r.request_number, status: r.status, sum: r.total_sum, by: r.approved_by_employee_id
    }))));
    log('  операции в моке: ' + JSON.stringify(store.cashOperations.map((op) => ({
        employee: op.employee_id, type: op.operation_type, amount: op.amount, desc: op.description
    }))));
    log('  балансы: прораб=' + balanceOf(7) + ', директор=' + balanceOf(8) + ', финансист=' + balanceOf(9));
    log('  ошибки/исключения в консоли: ' + (consoleErrors.length ? '\n    ' + consoleErrors.join('\n    ') : 'нет'));
} catch (error) {
    log('ОШИБКА ПРОГОНА: ' + (error && error.stack ? error.stack : error));
    failed += 1;
} finally {
    try { if (chrome) chrome.kill(); } catch { /* уже закрыт */ }
    try { server.close(); } catch { /* уже закрыт */ }
    const outDir = path.join(os.tmpdir(), 'rsk-fin');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'fin-workflow.txt'), report.join('\r\n'), 'utf8');
    // Код возврата 1, если есть непройденные проверки (удобно для автоматики).
    process.exit(failed === 0 ? 0 : 1);
}
