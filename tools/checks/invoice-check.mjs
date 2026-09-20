// =====================================================================
// Прогон v2.4.0 в браузере (реальный Chrome + мок Supabase):
//   1. снабженец загружает счёт по заявке (файл + цены) → «Ожидает оплаты»;
//   2. «Доставлено на объект» → позиции в «Реестре материалов» (безнал);
//   3. финансист видит счёт в блоке «Счета на материалы» и жмёт «Оплачено»;
//   4. директор пополняет подотчёт → «Ведомость пополнений»;
//   5. «Настройки»: язык uk/ru и цветовая схема (data-theme + перекраска).
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
const PORT = 8126;
const CDP_PORT = 9340;
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PROFILE = path.join(os.tmpdir(), 'rsk-fin', 'chrome-profile-invoice');
const BASE = 'http://127.0.0.1:' + PORT;

const USER_IDS = {
    8: '22222222-2222-4222-8222-222222222222',
    9: '33333333-3333-4333-8333-333333333333',
    10: '44444444-4444-4444-8444-444444444444'
};

const BASE_EMP = { status: 'active', phone: null, notes: null, created_at: '2026-01-01T00:00:00Z' };

const store = {
    currentEmployeeId: 8,
    employees: [
        { ...BASE_EMP, id: 8, name: 'Тест Директор', position: 'Директор', user_id: USER_IDS[8] },
        { ...BASE_EMP, id: 9, name: 'Тест Финансист', position: 'Финансист', user_id: USER_IDS[9] },
        { ...BASE_EMP, id: 10, name: 'Тест Снабженец', position: 'Снабженец', user_id: USER_IDS[10] }
    ],
    projects: [{ id: 3, name: 'Тестовый объект', foreman_id: null, status: 'active', created_at: '2026-01-01' }],
    sections: [{ id: 5, name: 'Кладочные работы', project_id: 3, plan_total: 100000 }],
    orders: [{
        id: 900, request_number: 'З-1/26', project_id: 3, section_id: 5,
        status: 'in_progress', supplier: null, total_sum: 0,
        payment_source: 'company', payment_status: 'paid',
        created_by_employee_id: 10, desired_date: '2026-02-01',
        purchase_data: {}, purchase_notes: null,
        invoice_path: null, invoice_file_name: null, invoice_uploaded_at: null,
        invoice_total: null, paid_at: null, paid_by_employee_id: null,
        delivered_at: null, closed_at: null, created_at: '2026-02-01T08:00:00Z'
    }],
    order_items: [
        { id: 5001, order_id: 900, name: 'Кирпич', unit: 'шт', qty: 1000, unit_price: null, total_price: null, payment_status: 'paid' },
        { id: 5002, order_id: 900, name: 'Цемент', unit: 'меш', qty: 50, unit_price: null, total_price: null, payment_status: 'paid' }
    ],
    cash_operations: [],
    cash_requests: [],
    cash_request_items: [],
    ids: { order: 901, orderItem: 5100, operation: 7000 }
};

const requests = [];
const report = [];
const log = (...a) => { const line = a.join(' '); report.push(line); console.log(line); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// =====================================================================
// РЕЖИМЫ «ПЛОХОЙ БАЗЫ» — для проверки раздела «Снабжение» и счетов
// =====================================================================
// 1. missingColumns — миграция v2.4.0 применилась наполовину: в orders нет
//    части колонок. Мок отвечает как настоящий PostgREST: на чтение 42703
//    («column orders.payment_status does not exist»), на запись PGRST204
//    («Could not find the 'payment_status' column of 'orders' ...»). Именно это
//    видели на боевой базе: счёт не сохранялся, у финансиста очередь пустая.
// 2. brokenOrdersJoin — переименовали связь внешнего ключа: GET orders падает
//    с PGRST200, то есть список заявок не загружается вообще.
const missingColumns = { orders: [] };
let brokenOrdersJoin = false;

// 3. checkViolationOrders — база отклонила запись по CHECK-ограничению (23514):
//    на orders.status висело СТАРОЕ ограничение со списком без 'delivered'.
//    Именно это видит снабженец, когда «заявка не закрывается»: приложение
//    писало status = 'delivered', а база отвечала
//    «new row for relation "orders" violates check constraint "orders_status_check"».
let checkViolationOrders = false;

/** Первая колонка из запроса, которой нет в «старой» базе (или null). */
function missingColumnFor(table, columns) {
    const absent = missingColumns[table] || [];
    const list = String(columns || '').split(',').map((col) => col.trim());
    return absent.find((col) => list.includes(col)) || null;
}


const balanceOf = (id) => store.cash_operations
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

const employee = (id) => store.employees.find((e) => e.id === id) || null;

/** Строки таблицы с вложенными связями, как их ждёт приложение. */
function rowsFor(table, params) {
    const eq = (rows, column) => {
        const raw = params[column];
        if (raw === undefined) return rows;
        // .in(...) обрабатывает inList(): здесь его пропускаем, иначе строки
        // отфильтровались бы «в ноль» и вложенные позиции не подгрузились
        if (String(raw).startsWith('in.')) return rows;
        return rows.filter((row) => String(row[column]) === String(raw).replace(/^eq\./, ''));
    };
    const inList = (rows, column) => {
        const raw = params[column];
        if (!raw) return rows;
        const list = String(raw).replace(/^in\.\(/, '').replace(/\)$/, '').split(',');
        return rows.filter((row) => list.includes(String(row[column])));
    };

    switch (table) {
        case 'employees': {
            // Фильтр по должности важен: по нему приложение ищет финансиста
            let rows = eq(store.employees.slice(), 'user_id');
            rows = eq(rows, 'position');
            rows = eq(rows, 'status');
            return rows;
        }
        case 'projects': return store.projects;
        case 'sections': return eq(store.sections, 'project_id');
        case 'orders': {
            let rows = eq(store.orders, 'id');
            rows = eq(rows, 'payment_source');
            rows = eq(rows, 'payment_status');
            rows = inList(rows, 'status');
            return rows.map((row) => ({
                ...row,
                project: store.projects.find((p) => p.id === row.project_id) || null,
                section: store.sections.find((s) => s.id === row.section_id) || null,
                created_by_emp: employee(row.created_by_employee_id),
                payer: employee(row.payer_employee_id)
            }));
        }
        case 'order_items': {
            let rows = store.order_items.slice();
            rows = eq(rows, 'order_id');
            rows = inList(rows, 'order_id');
            return rows;
        }
        case 'cash_operations': {
            let rows = store.cash_operations.slice();
            rows = eq(rows, 'operation_type');
            rows = eq(rows, 'employee_id');
            rows = inList(rows, 'employee_id');
            return rows.map((row) => ({ ...row, employee: employee(row.employee_id) }));
        }
        case 'cash_requests': return eq(store.cash_requests, 'id');
        case 'cash_request_items': return eq(store.cash_request_items, 'request_id');
        case 'employee_cash_balance': {
            const raw = params.employee_id;
            const ids = raw
                ? [Number(String(raw).replace(/^eq\./, ''))]
                : store.employees.map((e) => e.id);
            return ids.map((id) => ({ employee_id: id, name: employee(id)?.name || '—', balance: balanceOf(id) }));
        }
        default: return [];
    }
}

// supabase-js 2.45.4: .maybeSingle() ждёт ОБЪЕКТ, а не массив
function wantsSingleRow(table, params) {
    if (table === 'employee_cash_balance') return Boolean(params.employee_id);
    return false;
}

/** Обновление строк таблицы по фильтрам (id / order_id / employee_id). */
function updateRows(table, params, payload) {
    const rows = store[table] || [];
    const filters = ['id', 'order_id', 'employee_id', 'request_id']
        .filter((key) => params[key] !== undefined)
        .map((key) => [key, String(params[key]).replace(/^eq\./, '')]);

    const updated = [];

    rows.forEach((row) => {
        const matches = filters.length === 0 || filters.every(([key, value]) => String(row[key]) === value);
        if (!matches) return;

        Object.assign(row, payload);
        updated.push(row);

        if (table === 'orders') {
            log('    [мок] UPDATE orders #' + row.id + ' → status=' + row.status +
                ', payment_status=' + row.payment_status + ', счёт=' + (row.invoice_path || 'нет'));
        }
        if (table === 'order_items') {
            log('    [мок] UPDATE order_items #' + row.id + ' → цена=' + row.unit_price +
                ', оплата=' + row.payment_status);
        }
    });

    return updated;
}

/** Вставка строк (одной или списком) с автоинкрементом id. */
function insertRows(table, payload) {
    const rows = Array.isArray(payload) ? payload : [payload];

    const created = rows.map((row) => {
        const record = { id: store.ids[table] !== undefined ? store.ids[table]++ : undefined, ...row };

        if (table === 'cash_operations') {
            record.created_at = new Date().toISOString();
            record.operation_date = record.operation_date || new Date().toISOString().slice(0, 10);
            log('    [мок] INSERT cash_operations ' + record.operation_type + ' ' + record.amount +
                ' → ' + (employee(record.employee_id)?.name || record.employee_id) +
                ' :: ' + (record.description || '') + ' :: source=' + (record.source || '—'));
        }

        if (!store[table]) store[table] = [];
        store[table].push(record);
        return record;
    });

    return Array.isArray(payload) ? created : created[0];
}

// --------------------------------- мок Supabase ---------------------------------
function handleMock(req, res, body) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;
    const params = Object.fromEntries(url.searchParams.entries());
    const wantsObject = String(req.headers.accept || '').includes('vnd.pgrst.object');
    // Файлы в Storage приходят как multipart/form-data — JSON.parse на них падает
    const contentType = String(req.headers['content-type'] || '');
    const payload = body && contentType.includes('json') ? JSON.parse(body) : null;

    requests.push({ method: req.method, target: p + url.search, body: body || '' });

    if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' });
        res.end();
        return;
    }

    // ---- Auth ----
    if (p.includes('/auth/v1/token')) return sendJson(res, 200, session());
    if (p.includes('/auth/v1/user')) return sendJson(res, 200, session().user);
    if (p.includes('/auth/v1/logout')) return sendJson(res, 204, null);

    // ---- Storage: загрузка файла и подписанная ссылка ----
    if (p.startsWith('/storage/v1/object/sign/')) {
        return sendJson(res, 200, { signedURL: '/mock/signed-file' });
    }
    if (p.startsWith('/storage/v1/object/')) {
        const stored = p.replace('/storage/v1/object/', '');
        log('    [мок] STORAGE upload: ' + decodeURIComponent(stored));
        return sendJson(res, 200, { Key: decodeURIComponent(stored), path: decodeURIComponent(stored) });
    }

    const table = (p.match(/\/rest\/v1\/([a-z_]+)/) || [])[1] || null;
    if (!table) return sendJson(res, 200, []);

    // ---- Чтение ----
    if (req.method === 'GET') {
        if (table === 'orders' && brokenOrdersJoin) {
            return sendJson(res, 400, {
                code: 'PGRST200', details: null, hint: null,
                message: "Could not find a relationship between 'orders' and 'employees' in the schema cache"
            });
        }

        const absent = missingColumnFor(table, params.select);
        if (absent) {
            return sendJson(res, 400, {
                code: '42703', details: null, hint: null,
                message: 'column ' + table + '.' + absent + ' does not exist'
            });
        }

        const rows = rowsFor(table, params);

        if (wantsObject || wantsSingleRow(table, params)) {
            if (!rows.length) {
                return sendJson(res, 406, {
                    code: 'PGRST116', details: 'Results contain 0 rows', hint: null,
                    message: 'JSON object requested, multiple (or no) rows returned'
                });
            }
            return sendJson(res, 200, rows[0]);
        }

        return sendJson(res, 200, rows);
    }

    if (req.method === 'POST') return sendJson(res, 201, insertRows(table, payload));

    if (req.method === 'PATCH') {
        // База отклонила значение по CHECK-ограничению (боевая жалоба «заявка
        // не закрывается»): так выглядит устаревший список статусов.
        if (table === 'orders' && checkViolationOrders) {
            return sendJson(res, 400, {
                code: '23514', details: null, hint: null,
                message: 'new row for relation "orders" violates check constraint "orders_status_check"'
            });
        }

        // Запись в колонку, которой нет: PostgREST отвечает PGRST204
        const absent = missingColumnFor(table, Object.keys(payload || {}).join(','));
        if (absent) {
            return sendJson(res, 400, {
                code: 'PGRST204', details: null, hint: null,
                message: "Could not find the '" + absent + "' column of '" + table + "' in the schema cache"
            });
        }

        return sendJson(res, 200, updateRows(table, params, payload));
    }

    if (req.method === 'DELETE') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
        res.end();
        return;
    }

    return sendJson(res, 200, []);
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
            out = Buffer.from(String(data).replace(
                /SUPABASE_URL: '[^']*'/,
                "SUPABASE_URL: 'http://127.0.0.1:" + PORT + "/mock'"
            ), 'utf8');
        }

        res.writeHead(200, {
            'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
            // Без no-store Chrome отдаёт js-модули из своего кэша и прогон
            // проверяет старую версию файла, а не текущую
            'Cache-Control': 'no-store'
        });
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
        throw new Error('ошибка в странице: ' + JSON.stringify(
            result.exceptionDetails.exception?.description || result.exceptionDetails.text
        ));
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

const text = (id) => `(document.getElementById("${id}") || {}).innerText || ""`;

// ----------------------------------- прогон -----------------------------------
let chrome;
let failed = 0;

const ok = (name, cond, extra = '') => {
    log((cond ? '  ok   ' : '  FAIL ') + name + (extra ? ' :: ' + extra : ''));
    if (!cond) failed += 1;
};

async function main() {
    await new Promise((resolve) => server.listen(PORT, resolve));
    log('Прогон v2.4.0 (счета, доставка, ведомость, язык и тема): ' + BASE);

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
        if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
            consoleErrors.push('error: ' + msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
        }
    });

    await send('Runtime.enable');
    await send('Page.enable');

    // Вход под нужной ролью: мок отдаёт сотрудника, чей id выставлен в store
    const loginAs = async (employeeId, label) => {
        store.currentEmployeeId = employeeId;
        log('--- ' + label + ' (сотрудник #' + employeeId + ') ---');

        await send('Page.navigate', { url: BASE + '/?role=' + employeeId });
        await waitFor('!!document.getElementById("login-form") || !!document.getElementById("app-container")', 60);
        await evaluate('(() => { try { localStorage.clear(); } catch (e) { /* нет доступа */ } return true; })()');
        await send('Page.navigate', { url: BASE + '/?role=' + employeeId + '&t=' + Date.now() });
        await waitFor('!!document.getElementById("login-form") && typeof window.openOrderDetail === "function"', 60);

        await evaluate('(() => {' +
            'document.getElementById("login-email").value = "test@example.com";' +
            'document.getElementById("login-password").value = "secret123";' +
            'document.getElementById("login-form").dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));' +
            'return true; })()');

        const entered = await waitFor('!document.getElementById("app-container").classList.contains("hidden")', 40);
        ok('вход выполнен', entered);
        await sleep(900);
    };

    // ------------------- 1. Снабженец: счёт по заявке -------------------
    await loginAs(10, 'Снабженец');
    await evaluate('window.switchTab("orders")');
    await sleep(1400);

    await evaluate('window.openOrderDetail(900)');
    await sleep(700);
    const supActions = await evaluate(text('order-detail-actions'));
    ok('у снабженца есть «Счёт от поставщика» и «Доставлено на объект»',
        supActions.includes('Счёт от поставщика') && supActions.includes('Доставлено на объект'),
        supActions.replace(/\n/g, ' | '));

    // Регрессия (жалоба «заявку ещё не взяли в работу, а в карточке “Оплачено”»):
    // пока заявку не доставили и счёт не отмечен финансистом, карточка не должна
    // утверждать, что позиции оплачены.
    const detailBeforeInvoice = await evaluate(text('order-detail-content'));
    ok('до счёта и доставки карточка не показывает «Оплачено»',
        !detailBeforeInvoice.includes('Оплачено'),
        detailBeforeInvoice.replace(/\n/g, ' | ').slice(0, 160));

    await evaluate('window.openOrderInvoiceModal(900)');
    await sleep(700);

    await evaluate('(() => {' +
        'document.getElementById("order-invoice-supplier").value = "Эпицентр";' +
        'const rows = document.querySelectorAll(".order-invoice-item");' +
        'rows[0].querySelector(".order-invoice-price").value = "5";' +
        'rows[1].querySelector(".order-invoice-price").value = "180";' +
        'window.recalcOrderInvoiceTotal();' +
        'const dt = new DataTransfer();' +
        'dt.items.add(new File(["%PDF-1.4 тестовый счёт"], "schet-123.pdf", { type: "application/pdf" }));' +
        'document.getElementById("order-invoice-file").files = dt.files;' +
        'document.getElementById("order-invoice-form").dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));' +
        'return true; })()');
    await sleep(2400);

    const order = store.orders.find((row) => row.id === 900);
    const items = store.order_items.filter((row) => row.order_id === 900);

    ok('счёт сохранён: файл, поставщик и сумма 14 000',
        order.invoice_path && order.invoice_file_name === 'schet-123.pdf' &&
        order.supplier === 'Эпицентр' && Number(order.invoice_total) === 14000,
        JSON.stringify({ path: order.invoice_path, supplier: order.supplier, total: order.invoice_total }));
    ok('цены позиций записаны (5 и 180)', Number(items[0].unit_price) === 5 && Number(items[1].unit_price) === 180,
        JSON.stringify(items.map((i) => i.unit_price)));
    ok('заявка ждёт оплаты (payment_status = debt)', order.payment_status === 'debt', order.payment_status);

    // ------------------- 2. Доставка на объект -------------------
    await evaluate('window.openOrderDetail(900)');
    await sleep(700);
    await evaluate('window.openCloseOrderModal(900)');
    await sleep(800);
    const deliveryInfo = await evaluate(text('close-order-info'));
    ok('в окне доставки видно объект и сумму счёта', deliveryInfo.includes('Тестовый объект'), deliveryInfo.replace(/\n/g, ' | ').slice(0, 120));

    // Регрессия (жалоба «в окне доставки видно “Оплачено”, хотя счёт не оплачен»):
    // статус в строках позиций следует за выбором «кто платит» и пересчитывается
    // на месте, а не показывается текстом «Ожидает оплаты / Оплачено».
    const pickPaymentSource = async (value) => {
        await evaluate('(() => {' +
            'const radio = document.querySelector(\'input[name="close-order-payment-source"][value="' + value + '"]\');' +
            'radio.checked = true;' +
            'radio.dispatchEvent(new Event("change", { bubbles: true }));' +
            'return true; })()');
        await sleep(300);
        return evaluate(text('close-order-items'));
    };

    const hintCompany = await evaluate(text('close-order-items'));
    ok('окно доставки: «фирма» → позиции «Ожидает оплаты», а не «Оплачено»',
        hintCompany.includes('Ожидает оплаты') && !hintCompany.includes('Оплачено'),
        hintCompany.replace(/\n/g, ' | ').slice(0, 120));

    const hintEmployee = await pickPaymentSource('employee');
    ok('окно доставки: «подотчёт снабженца» → позиции «Оплачено»',
        hintEmployee.includes('Оплачено') && !hintEmployee.includes('Ожидает оплаты'),
        hintEmployee.replace(/\n/g, ' | ').slice(0, 120));

    const hintBack = await pickPaymentSource('company');
    ok('окно доставки: вернулись на «фирму» → снова «Ожидает оплаты»',
        hintBack.includes('Ожидает оплаты') && !hintBack.includes('Оплачено'),
        hintBack.replace(/\n/g, ' | ').slice(0, 120));

    await evaluate('document.getElementById("close-order-form").dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }))');
    await sleep(2400);

    ok('статус «Доставлено на объект» с датой',
        order.status === 'delivered' && !!order.delivered_at,
        'status=' + order.status + ', delivered_at=' + order.delivered_at);
    ok('позиции ушли в реестр со статусом «Ожидает оплаты»',
        items.every((row) => row.payment_status === 'debt'),
        JSON.stringify(items.map((i) => i.payment_status)));
    ok('безнал: расход в подотчёт не создан', store.cash_operations.length === 0,
        'операций: ' + store.cash_operations.length);

    // Долг перед поставщиком должен быть виден и в карточке заявки
    await evaluate('window.openOrderDetail(900)');
    await sleep(700);
    const detailAfterDelivery = await evaluate(text('order-detail-content'));
    ok('после доставки карточка показывает «Ожидает оплаты»',
        detailAfterDelivery.includes('Ожидает оплаты') && !detailAfterDelivery.includes('Оплачено'),
        detailAfterDelivery.replace(/\n/g, ' | ').slice(0, 160));

    await evaluate('window.hideModal("order-detail-modal")');
    await sleep(300);

    await evaluate('window.switchTab("registry")');
    await sleep(1600);
    const registryText = await evaluate(text('registry-tbody'));
    ok('реестр показывает материал заявки и «Ожидает оплаты»',
        registryText.includes('Кирпич') && registryText.includes('Ожидает оплаты'),
        registryText.replace(/\n/g, ' | ').slice(0, 160));

    // ------------------- 3. Финансист: оплата счёта -------------------
    await loginAs(9, 'Финансист');

    const finPanel = await evaluate(text('material-invoices-panel'));
    ok('счёт на материалы виден на рабочем столе финансиста',
        finPanel.includes('Счета на материалы') && finPanel.includes('З-1/26') &&
        finPanel.replace(/\s+/g, ' ').includes('14 000'),
        finPanel.replace(/\n/g, ' | ').slice(0, 160));

    // Рабочий стол финансиста — два блока на одной странице (не вкладки):
    // счета на материалы и одобренные заявки на выдачу
    const finBlocks = await evaluate('(() => {' +
        'const vis = (id) => { const el = document.getElementById(id); return !!el && getComputedStyle(el).display !== "none"; };' +
        'return { invoices: vis("material-invoices-panel"), approved: vis("financier-approved-head"),' +
        ' filters: vis("cashreq-filters"),' +
        ' approvedText: (document.getElementById("financier-approved-head") || {}).innerText || "" }; })()');
    ok('на рабочем столе финансиста два блока: счета и одобренные заявки',
        finBlocks.invoices === true && finBlocks.approved === true &&
        finBlocks.approvedText.includes('Одобренные заявки на выдачу'),
        JSON.stringify({ invoices: finBlocks.invoices, approved: finBlocks.approved }) +
        ' :: ' + finBlocks.approvedText.replace(/\n/g, ' | ').slice(0, 120));
    ok('общие фильтры заявок у финансиста скрыты', finBlocks.filters === false,
        'cashreq-filters виден: ' + finBlocks.filters);

    const balanceBefore = balanceOf(9);
    await evaluate('window.confirm = () => true');
    await evaluate('window.markMaterialInvoicePaid(900)');
    await sleep(2000);

    ok('счёт отмечен оплаченным (кто и когда)',
        order.payment_status === 'paid' && !!order.paid_at && Number(order.paid_by_employee_id) === 9,
        JSON.stringify({ payment_status: order.payment_status, paid_by: order.paid_by_employee_id }));
    ok('позиции заявки стали «Оплачено»',
        store.order_items.filter((row) => row.order_id === 900).every((row) => row.payment_status === 'paid'));
    ok('подотчёт финансиста НЕ изменился (безнал фирмы)', balanceOf(9) === balanceBefore,
        'было ' + balanceBefore + ', стало ' + balanceOf(9));

    const finPanelAfter = await evaluate(text('material-invoices-panel'));
    ok('очередь счетов опустела', finPanelAfter.includes('Счетов к оплате нет'),
        finPanelAfter.replace(/\n/g, ' | ').slice(0, 120));

    // ------------------- 4. Директор: пополнение и ведомость -------------------
    await loginAs(8, 'Директор');
    await evaluate('window.switchTab("cash-requests")');
    await sleep(1600);

    await evaluate('window.openTopUpBalanceModal()');
    await sleep(900);
    await evaluate('(() => {' +
        'document.getElementById("topup-balance-amount").value = "5000";' +
        'document.getElementById("topup-balance-comment").value = "Передал наличными";' +
        'document.getElementById("topup-balance-form").dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));' +
        'return true; })()');
    await sleep(2200);

    const topUp = store.cash_operations.find((op) => op.employee_id === 9 && op.operation_type === 'issue');
    ok('пополнение помечено source = financier_topup (попадёт в ведомость)',
        !!topUp && topUp.source === 'financier_topup' && Number(topUp.amount) === 5000,
        topUp ? JSON.stringify({ amount: topUp.amount, source: topUp.source }) : 'нет операции');
    ok('баланс финансиста 5 000', balanceOf(9) === 5000, 'баланс: ' + balanceOf(9));

    const hintText = await evaluate(text('financier-balance-hint'));
    ok('напротив кнопки пополнения видно баланс финансиста (5 000)',
        hintText.replace(/\s/g, '').includes('5000'), hintText);

    await evaluate('window.openFinancierTopUpStatement()');
    await sleep(1500);
    const statementBody = await evaluate(text('financier-statement-body'));
    const statementSummary = await evaluate(text('financier-statement-summary'));
    const statementText = statementBody.replace(/\s+/g, ' ');
    ok('ведомость: строка с датой, суммой и комментарием',
        statementText.includes('5 000') && statementText.includes('Передал наличными') &&
        /\d{2}\.\d{2}\.\d{4}/.test(statementText),
        statementText.slice(0, 200));
    ok('ведомость: итог «Всего пополнено» + количество',
        statementSummary.toLowerCase().includes('всего пополнено') &&
        statementSummary.toLowerCase().includes('пополнений') &&
        statementSummary.replace(/\s+/g, ' ').includes('5 000'),
        statementSummary.replace(/\n/g, ' | '));

    // Выгрузку проверяем без скачивания: подменяем XLSX.writeFile
    const exported = await evaluate('(() => {' +
        'const original = XLSX.writeFile; let name = null;' +
        'XLSX.writeFile = (workbook, fileName) => { name = fileName; };' +
        'window.exportFinancierTopUpStatement();' +
        'XLSX.writeFile = original; return name; })()');
    ok('ведомость выгружается в Excel (.xlsx)', typeof exported === 'string' && exported.includes('.xlsx'),
        String(exported));

    // ------------------- 5. Язык и цветовая схема -------------------
    await evaluate('window.openSettings()');
    await sleep(600);
    const settingsText = await evaluate(text('settings-modal'));
    ok('в настройках есть оба языка и 6 цветов',
        settingsText.includes('Русский') && settingsText.includes('Українська') &&
        settingsText.includes('Зелёная') && settingsText.includes('Графит'),
        settingsText.replace(/\n/g, ' | ').slice(0, 160));

    await evaluate('window.chooseTheme("blue")');
    await sleep(500);
    const themeState = await evaluate('(() => {' +
        'const btn = document.getElementById("create-cash-request-btn");' +
        'return { attr: document.documentElement.getAttribute("data-theme"),' +
        ' brand: getComputedStyle(document.documentElement).getPropertyValue("--brand").trim(),' +
        ' button: getComputedStyle(btn).backgroundColor }; })()');
    ok('тема «Синяя» применена и перекрасила кнопки Tailwind',
        themeState.attr === 'blue' && themeState.brand === '#1d4ed8' &&
        themeState.button === 'rgb(29, 78, 216)',
        JSON.stringify(themeState));

    // Реестр открыт у директора — после смены языка он перерисуется сам
    await evaluate('window.switchTab("registry")');
    await sleep(1500);

    await evaluate('window.chooseLanguage("uk")');
    await sleep(1600);
    const ukState = await evaluate('(() => ({' +
        ' projects: (document.getElementById("btn-projects") || {}).textContent || "",' +
        ' registry: (document.getElementById("registry-tbody") || {}).innerText || "",' +
        ' title: (document.querySelector("#settings-modal h3") || {}).textContent || "",' +
        ' htmlLang: document.documentElement.getAttribute("lang") }))()');
    ok('украинская версия: разделы, настройки, реестр и <html lang>',
        ukState.projects.includes("Об'єкти") && ukState.title.includes('Налаштування') &&
        ukState.htmlLang === 'uk' && ukState.registry.includes('Сплачено'),
        JSON.stringify(ukState).slice(0, 240));

    await evaluate('window.chooseLanguage("ru")');
    await evaluate('window.chooseTheme("green")');
    await sleep(1500);
    const backState = await evaluate('(() => ({' +
        ' projects: (document.getElementById("btn-projects") || {}).textContent || "",' +
        ' registry: (document.getElementById("registry-tbody") || {}).innerText || "",' +
        ' theme: document.documentElement.getAttribute("data-theme"),' +
        ' stored: localStorage.getItem("rsk.theme") + "/" + localStorage.getItem("rsk.lang") }))()');
    ok('возврат на русский и зелёную тему',
        backState.projects.includes('Объекты') && backState.registry.includes('Оплачено') &&
        backState.theme === 'green' && backState.stored === 'green/ru',
        JSON.stringify(backState));

    // =================================================================
    // РЕГРЕССИЯ «БАЗА НЕ ОБНОВЛЕНА» (боевая жалоба: снабженец не может
    // сохранить счёт, финансист не видит счетов). Проверяем, что приложение
    // говорит, чего не хватает, а не молчит пустыми списками.
    // =================================================================
    log('--- база не обновлена: половина миграции v2.4.0 ---');

    // 1. Список заявок вообще не загружается (сломана связь внешнего ключа):
    //    раздел «Снабжение» обязан объяснить это плашкой, а не показать «Заявок нет».
    brokenOrdersJoin = true;
    await loginAs(10, 'Снабженец: база отвечает ошибкой');
    await evaluate('window.switchTab("orders")');
    await sleep(1600);

    const ordersWarn = await evaluate(text('orders-warning'));
    ok('«Снабжение» показывает плашку вместо пустого списка',
        ordersWarn.includes('Заявки не загрузились'),
        ordersWarn.replace(/\n/g, ' ').slice(0, 160));

    brokenOrdersJoin = false;

    // 2. Миграция применилась наполовину: в orders нет четырёх колонок.
    //    Заявку возвращаем в «не оплачена»: именно по такой заявке снабженец
    //    сохраняет счёт на боевой базе, и приложение пишет payment_status = 'debt'.
    //    Важно сделать это ДО перечитывания списка — иначе в кэше приложения
    //    останется paid_at и оно не станет писать payment_status вовсе.
    missingColumns.orders = ['payment_status', 'delivered_at', 'paid_at', 'paid_by_employee_id'];

    const invoiceOrder = store.orders.find((row) => row.id === 900);
    const paidAtBefore = invoiceOrder.paid_at;
    invoiceOrder.paid_at = null;
    invoiceOrder.payment_status = 'debt';

    // База «починилась»: перечитываем список заявок. Без этого в кэше модуля
    // пусто, и окно счёта открывать не по чему (тест ловил «Заявка не найдена»).
    await evaluate('window.switchTab("orders")');
    await sleep(1500);

    const ordersWarnCleared = await evaluate(text('orders-warning'));
    ok('после восстановления базы плашка исчезает',
        !ordersWarnCleared.includes('не загрузились'),
        ordersWarnCleared.replace(/\n/g, ' ').slice(0, 120) || 'плашки нет');

    await evaluate('window.openOrderDetail(900)');
    await sleep(700);
    await evaluate('window.openOrderInvoiceModal(900)');
    await sleep(700);
    await evaluate('(() => {' +
        'const rows = document.querySelectorAll(".order-invoice-item");' +
        'rows.forEach((row) => { row.querySelector(".order-invoice-price").value = "5"; });' +
        'document.getElementById("order-invoice-supplier").value = "Эпицентр";' +
        'document.getElementById("order-invoice-form").dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));' +
        'return true; })()');
    await sleep(1500);

    const saveToast = await evaluate('Array.from(document.body.children)' +
        '.filter((el) => el.classList && el.classList.contains("top-4"))' +
        '.map((el) => el.innerText).join(" | ")');
    ok('сохранение счёта объясняет, что база не обновлена',
        saveToast.includes('payment_status') && saveToast.includes('migrate-v2.4.sql'),
        saveToast.replace(/\n/g, ' ').slice(0, 200));

    await evaluate('window.hideModal("order-invoice-modal")');

    // 3. Реестр материалов не смог загрузить заявки — плашка над таблицей
    await loginAs(8, 'Директор: реестр на «старой» базе');
    await evaluate('window.switchTab("registry")');
    await sleep(1600);
    const registryWarn = await evaluate(text('registry-warning'));
    ok('«Реестр материалов» объясняет, почему нет заявок',
        registryWarn.includes('migrate-v2.4.sql'),
        registryWarn.replace(/\n/g, ' ').slice(0, 200));

    // 4. Рабочий стол финансиста: очередь счетов не загрузилась
    await loginAs(9, 'Финансист: база не обновлена');
    await sleep(1800);
    const finBroken = await evaluate(text('material-invoices-panel'));
    ok('финансист видит объяснение вместо пустой очереди счетов',
        finBroken.includes('Не удалось загрузить счета') && finBroken.includes('migrate-v2.4.sql'),
        finBroken.replace(/\n/g, ' ').slice(0, 200));

    // 5. База отклонила СТАТУС (боевая жалоба «заявка не закрывается»):
    //    на orders.status висело старое CHECK-ограничение без 'delivered'.
    //    Сотрудник должен увидеть объяснение и файл миграции, а не английский
    //    текст Postgres «violates check constraint "orders_status_check"».
    log('--- заявка не закрывается: устаревшее ограничение статусов ---');
    checkViolationOrders = true;
    invoiceOrder.status = 'in_progress';   // окно доставки открывается только из «В работе»

    await loginAs(10, 'Снабженец: ограничение статусов');
    await evaluate('window.switchTab("orders")');
    await sleep(1600);
    await evaluate('window.openOrderDetail(900)');
    await sleep(700);
    await evaluate('window.openCloseOrderModal(900)');
    await sleep(800);
    await evaluate('(() => {' +
        'document.querySelectorAll(".close-order-item").forEach((row) => {' +
        '    row.querySelector(".close-order-price").value = "5"; });' +
        'document.getElementById("close-order-supplier").value = "Эпицентр";' +
        'document.getElementById("close-order-form").dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));' +
        'return true; })()');
    await sleep(1800);

    const checkToast = await evaluate('Array.from(document.body.children)' +
        '.filter((el) => el.classList && el.classList.contains("top-4"))' +
        '.map((el) => el.innerText).join(" | ")');
    ok('отказ по CHECK-ограничению объясняется по-русски и ведёт к миграции',
        checkToast.includes('orders_status_check') && checkToast.includes('migrate-v2.4.sql') &&
        !/violates check constraint/i.test(checkToast),
        checkToast.replace(/\n/g, ' ').slice(0, 220));

    checkViolationOrders = false;
    invoiceOrder.status = 'delivered';

    // Возвращаем мок в рабочее состояние, чтобы итоговая сводка была честной
    missingColumns.orders = [];
    invoiceOrder.paid_at = paidAtBefore;
    invoiceOrder.payment_status = 'paid';

    log('--- ИТОГ ---');
    log(failed === 0
        ? '  ВСЁ ВЕРНО: счёт → доставка → реестр → оплата, ведомость, язык и тема работают'
        : '  не прошло проверок: ' + failed);
    log('  заявка в моке: ' + JSON.stringify({
        status: order.status, supplier: order.supplier,
        invoice: order.invoice_file_name, total: order.invoice_total, payment_status: order.payment_status
    }));
    log('  операции: ' + JSON.stringify(store.cash_operations.map((op) => ({
        employee: op.employee_id, type: op.operation_type, amount: op.amount, source: op.source
    }))));
    log('  балансы: директор=' + balanceOf(8) + ', финансист=' + balanceOf(9));
    log('  ошибки в консоли: ' + (consoleErrors.length ? '\n    ' + consoleErrors.join('\n    ') : 'нет'));
}




// ---------------------------------- сессия ----------------------------------
// Сессия строится под ТЕКУЩУЮ роль: у каждого тестового сотрудника свой
// user_id, иначе приложение нашло бы одного и того же «сотрудника».
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
        refresh_token: 'refresh-' + userId,
        user: {
            id: userId, aud: 'authenticated', role: 'authenticated',
            email: 'test@example.com', app_metadata: {}, user_metadata: {},
            created_at: '2026-01-01T00:00:00Z'
        }
    };
}


try {
    await main();
} catch (error) {
    log('ОШИБКА ПРОГОНА: ' + (error && error.stack ? error.stack : error));
    failed += 1;
} finally {
    try { if (chrome) chrome.kill(); } catch { /* уже закрыт */ }
    try { server.close(); } catch { /* уже закрыт */ }
    const outDir = path.join(os.tmpdir(), 'rsk-fin');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'invoice-check.txt'), report.join('\r\n'), 'utf8');
    // Код возврата 1, если есть непройденные проверки (удобно для автоматики).
    process.exit(failed === 0 ? 0 : 1);
}
