// =====================================================================
// Прогон нового согласования заявок на финансирование (v2.2.0) в браузере:
//   прораб создаёт → директор (одобрить / на доработку / отклонить)
//   → финансист выдаёт «Выдано» (сумма уходит с ЕГО подотчёта получателю).
// Затем — рабочий экран прораба: фильтры блоков «💰 Мои заявки на
// финансирование» и «📦 Мои заявки на материалы», нажимаемая целиком карточка
// заявки и «📥 Архив» (автор убирает отработанную заявку: выданную,
// отклонённую, доставленную).
// В самом конце язык переключается на украинский (window.i18n.setLang('uk') —
// то же, что делает окно настроек) и проверяется, что экран стал украинским:
// так ловится «надпись в модуле есть, а пары для неё в словаре нет».
// Приложение отдаётся с локального сервера, «Supabase» подменён моком,
// поэтому видно, что реально делает интерфейс и какие строки пишутся в базу.
// =====================================================================
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { launchChrome } from './chrome-start.mjs';

// Корень приложения. По умолчанию — на две папки выше самого файла
// (tools/checks → корень репозитория). Можно переопределить: APP_ROOT=...
const ROOT = process.env.APP_ROOT
    ? path.resolve(process.env.APP_ROOT)
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 8124;
const CDP_PORT = 9338;
// Браузер поднимает chrome-start.mjs (путь к нему — CHROME_PATH, запуск «лестницей»).
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

let PROFILE = path.join(os.tmpdir(), 'rsk-fin', 'chrome-profile-workflow');
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
    // Заявки на материалы прораба — три этапа закупки. На них проверяются
    // фильтры блока «📦 Мои заявки на материалы»: «поданы в снабжение»
    // (новые и взятые в работу), «доставлено на объект» и «архив».
    // created_by_employee_id = 7: заявки создал прораб, поэтому он же убирает
    // отработанные в архив (js/modules/orders.js → canArchiveOrder).
    orders: [
        { id: 901, request_number: 'З-11/26', project_id: 3, section_id: 5, status: 'new', supplier: null, total_sum: null, created_by_employee_id: 7, created_at: '2026-09-17T08:00:00Z', section: { id: 5, name: 'Кладочные работы' } },
        { id: 902, request_number: 'З-12/26', project_id: 3, section_id: 5, status: 'in_progress', supplier: null, total_sum: null, created_by_employee_id: 7, created_at: '2026-09-18T08:00:00Z', section: { id: 5, name: 'Кладочные работы' } },
        { id: 903, request_number: 'З-13/26', project_id: 3, section_id: 5, status: 'delivered', supplier: 'Стройбаза Одесса', total_sum: 25000, created_by_employee_id: 7, created_at: '2026-09-19T08:00:00Z', section: { id: 5, name: 'Кладочные работы' } }
    ],
    // Позиции доставленной заявки: на них проверяется подробная карточка,
    // которая открывается нажатием на карточку заявки в списке материалов.
    orderItems: [
        { id: 801, order_id: 903, name: 'Цемент М400', unit: 'меш', qty: 100, unit_price: 200, total_price: 20000, payment_status: 'debt' },
        { id: 802, order_id: 903, name: 'Песок', unit: 'т', qty: 5, unit_price: 1000, total_price: 5000, payment_status: 'debt' }
    ],
    cashRequests: [],
    cashRequestItems: [],
    cashOperations: [],
    nextRequestId: 101,
    nextItemId: 1001,
    nextOperationId: 5001,
    nextOrderId: 904
};

// Прямые INSERT в orders и cash_requests база с v2.8.0 запрещает
// (database/migrate-v2.8-finance-rpc-audit.sql → revoke insert): заявки
// создаёт только серверная команда. Всё, что приложение пишет сюда напрямую,
// попадает в этот список и валит проверку в конце прогона.
const directInserts = [];

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

/** Строки таблицы из «базы» с учётом страниц (offset/limit). */
function rowsFor(table, params) {
    const byEq = (rows, column) => {
        const raw = params[column];
        if (!raw) return rows;
        return rows.filter((row) => String(row[column]) === String(raw).replace(/^eq\./, ''));
    };

    // Фильтр «по списку»: project_id=in.(3) — так рабочий экран прораба просит
    // заявки только по своим объектам. Значение вида eq.3 сюда не относится:
    // это равенство, и as список его разбирать нельзя (иначе строки исчезли бы).
    const byIn = (rows, column) => {
        const raw = params[column];
        if (!raw || !String(raw).startsWith('in.(')) return rows;
        const list = String(raw).replace(/^in\.\(/, '').replace(/\)$/, '').split(',').map((v) => v.trim());
        return rows.filter((row) => list.includes(String(row[column])));
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
        case 'orders': {
            let rows = byEq(store.orders, 'id');
            rows = byIn(rows, 'project_id');
            return rows.map((row) => ({
                ...row,
                project: store.projects.find((p) => p.id === row.project_id) || null,
                section: store.sections.find((s) => s.id === row.section_id) || null,
                created_by_emp: employee(row.created_by_employee_id),
                payer: employee(row.payer_employee_id)
            }));
        }
        case 'order_items': return byEq(store.orderItems, 'order_id');
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
                .filter(() => params.employee_id || true);
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
    // openOrderDetail() добирает заявку по id через .maybeSingle() — тоже ждёт объект
    if (table === 'orders') return Boolean(params.id);
    return false;
}

// -------------------- серверные команды (RPC, v2.8.0) --------------------
// Мини-модель базы: те же четыре команды, что и в
// database/migrate-v2.8-finance-rpc-audit.sql. Отвечаем так же, как PostgREST:
// на успех — JSON-объект (в базе это jsonb), на отказ — тело с кодом и русским
// текстом (приложение разбирает его в js/database.js → parseRpcFailure).

const YEAR_SHORT = String(new Date().getFullYear()).slice(-2);
const todayISO = () => new Date().toISOString().slice(0, 10);
const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

// Номер заявки база считает «Ф-N/YY» и «№ N/YY» под блокировкой; в моке —
// максимум по текущему году + 1, как в миграции v2.8.0.
function nextNumber(prefix, numbers) {
    const pattern = new RegExp('^' + prefix + '([0-9]+)/' + YEAR_SHORT + '$');
    const max = numbers.reduce((acc, value) => {
        const parts = pattern.exec(String(value || ''));
        return parts ? Math.max(acc, Number(parts[1])) : acc;
    }, 0);
    return prefix + (max + 1) + '/' + YEAR_SHORT;
}

function rpcError(res, code, message) {
    log('    [мок] RPC отказ ' + code + ': ' + message);
    return sendJson(res, 400, { code, message, details: null, hint: null });
}

function rpcCreateCashRequest(res, params) {
    const items = Array.isArray(params.p_items) ? params.p_items : [];
    if (!items.length) return rpcError(res, '22023', 'В заявке должно быть от 1 до 200 позиций');

    const normalized = items.map((it) => {
        const qty = round2(it.qty);
        const unitPrice = round2(it.unit_price);
        return {
            name: String(it.name || '').trim(),
            unit: String(it.unit || 'м²').trim(),
            qty,
            unit_price: unitPrice,
            total_price: round2(qty * unitPrice)
        };
    });
    const totalSum = round2(normalized.reduce((sum, it) => sum + it.total_price, 0));
    const id = store.nextRequestId++;
    const requestNumber = nextNumber('Ф-', store.cashRequests.map((row) => row.request_number));

    store.cashRequests.push({
        id,
        request_number: requestNumber,
        employee_id: store.currentEmployeeId,
        project_id: params.p_project_id,
        section_id: params.p_section_id,
        comment: params.p_comment || null,
        total_sum: totalSum,
        status: 'pending',
        rejection_reason: null,
        approved_by_employee_id: null,
        approved_at: null,
        issued_operation_id: null,
        created_at: new Date().toISOString()
    });
    normalized.forEach((it) => store.cashRequestItems.push({ id: store.nextItemId++, request_id: id, ...it }));

    log('    [мок] RPC create_cash_request_with_items → ' + requestNumber +
        ' на ' + totalSum + ' (' + normalized.length + ' поз., автор #' + store.currentEmployeeId + ')');

    return sendJson(res, 200, {
        request_id: id,
        request_number: requestNumber,
        status: 'pending',
        total_sum: totalSum,
        items_count: normalized.length
    });
}

function rpcIssueCashRequest(res, params) {
    const request = store.cashRequests.find((row) => row.id === Number(params.p_request_id));
    if (!request) return rpcError(res, 'P0002', 'Финансовая заявка не найдена');
    if (request.status !== 'approved') {
        return rpcError(res, 'P0001', 'Заявка должна быть в статусе "Одобрено"');
    }

    const recipientName = (employee(request.employee_id) || {}).name || '—';
    const recipient = {
        id: store.nextOperationId++,
        employee_id: request.employee_id,
        operation_type: 'issue',
        amount: request.total_sum,
        description: 'Заявка ' + request.request_number + ' — выдача подотчёта',
        source: 'cash_request_issue',
        operation_date: todayISO(),
        created_by: currentUserId()
    };
    store.cashOperations.push(recipient);

    // Своего подотчёта выдача касается только у Финансиста: он платит со своего.
    let financier = null;
    if ((employee(store.currentEmployeeId) || {}).position === 'Финансист') {
        financier = {
            id: store.nextOperationId++,
            employee_id: store.currentEmployeeId,
            operation_type: 'return',
            amount: request.total_sum,
            description: 'Выдача по заявке ' + request.request_number + ' — ' + recipientName,
            source: 'cash_request_debit',
            operation_date: todayISO(),
            created_by: currentUserId()
        };
        store.cashOperations.push(financier);
    }

    request.status = 'issued';
    request.issued_operation_id = recipient.id;

    log('    [мок] RPC issue_cash_request → ' + request.request_number + ': приход #' + recipient.id +
        ' на ' + request.total_sum + (financier ? ', списание #' + financier.id : ', списание не нужно (роль не Финансист)'));

    return sendJson(res, 200, {
        request_id: request.id,
        request_number: request.request_number,
        status: 'issued',
        amount: request.total_sum,
        recipient_operation_id: recipient.id,
        financier_operation_id: financier ? financier.id : null
    });
}

function rpcCreateOrder(res, params) {
    const items = Array.isArray(params.p_items) ? params.p_items : [];
    if (!items.length) return rpcError(res, '22023', 'В заявке должно быть от 1 до 200 позиций');

    // Позиции заявки на материалы база хранит БЕЗ цен: это заявка, а не счёт.
    const normalized = items.map((it) => ({
        name: String(it.name || '').trim(),
        unit: String(it.unit || 'шт').trim(),
        qty: round2(it.qty)
    }));

    const id = store.nextOrderId++;
    const requestNumber = nextNumber('№ ', store.orders.map((row) => row.request_number));

    store.orders.push({
        id,
        request_number: requestNumber,
        project_id: params.p_project_id,
        section_id: params.p_section_id,
        status: 'new',
        desired_date: params.p_desired_date || null,
        purchase_data: params.p_comment ? { comment: String(params.p_comment).trim() } : {},
        created_by_employee_id: store.currentEmployeeId,
        payment_source: 'company'
    });
    normalized.forEach((it) => store.orderItems.push({ id: store.nextItemId++, order_id: id, ...it }));

    log('    [мок] RPC create_order_with_items → ' + requestNumber + ' (' + normalized.length +
        ' поз.) — позиции без цен, статус оплаты не выставлен');

    return sendJson(res, 200, {
        order_id: id,
        request_number: requestNumber,
        status: 'new',
        items_count: normalized.length
    });
}

function rpcSaveOwnDelivery(res, params) {
    const order = store.orders.find((row) => row.id === Number(params.p_order_id));
    if (!order) return rpcError(res, 'P0002', 'Заявка на материалы не найдена');

    const old = store.cashOperations.find((op) => op.order_id === order.id && op.source === 'own_delivery');
    const needed = params.p_enabled === true && params.p_charge !== 'firm' && round2(params.p_amount) > 0;

    if (!needed) {
        if (!old) {
            log('    [мок] RPC save_own_delivery_expense → расход не нужен, записи не было');
            return sendJson(res, 200, {
                order_id: order.id, operation_id: null, action: 'unchanged', amount: 0
            });
        }
        store.cashOperations = store.cashOperations.filter((op) => op.id !== old.id);
        log('    [мок] RPC save_own_delivery_expense → своя доставка убрана (операция #' + old.id + ')');
        return sendJson(res, 200, {
            order_id: order.id, operation_id: null, action: 'deleted', amount: 0
        });
    }

    const amount = round2(params.p_amount);
    const rate = Math.min(Math.max(round2(params.p_vat_rate), 0), 100);
    const payload = {
        employee_id: params.p_charge === 'employee' ? Number(params.p_employee_id) : store.currentEmployeeId,
        operation_type: 'expense',
        amount,
        category: 'delivery',
        project_id: order.project_id,
        section_id: order.section_id,
        order_id: order.id,
        source: 'own_delivery',
        description: 'Своя доставка по заявке ' + order.request_number,
        vat_rate: rate,
        vat_amount: rate > 0 ? round2(amount * rate / (100 + rate)) : 0,
        operation_date: todayISO(),
        created_by: currentUserId()
    };

    if (old) {
        Object.assign(old, payload);
        log('    [мок] RPC save_own_delivery_expense → операция #' + old.id + ' обновлена на ' + amount);
        return sendJson(res, 200, {
            order_id: order.id, operation_id: old.id, action: 'updated',
            employee_id: old.employee_id, amount, vat_amount: old.vat_amount
        });
    }

    const created = { id: store.nextOperationId++, ...payload };
    store.cashOperations.push(created);
    log('    [мок] RPC save_own_delivery_expense → операция #' + created.id + ' на ' + amount +
        ' на сотруднике #' + created.employee_id + ' (charge=' + params.p_charge + ')');
    return sendJson(res, 200, {
        order_id: order.id, operation_id: created.id, action: 'created',
        employee_id: created.employee_id, amount, vat_amount: created.vat_amount
    });
}

// Диспетчер серверных команд: имена и параметры — как в
// database/migrate-v2.8-finance-rpc-audit.sql (блок 6 выдаёт на них право
// authenticated). Неизвестная команда — это ошибка мока, а не приложения.
function handleRpc(fnName, body, res) {
    const params = body || {};
    log('    [мок] RPC ' + fnName + ' ' + JSON.stringify(params).slice(0, 220));

    if (!params.p_idempotency_key) return rpcError(res, '22023', 'idempotency_key обязателен');

    switch (fnName) {
        case 'create_cash_request_with_items': return rpcCreateCashRequest(res, params);
        case 'issue_cash_request':            return rpcIssueCashRequest(res, params);
        case 'create_order_with_items':       return rpcCreateOrder(res, params);
        case 'save_own_delivery_expense':     return rpcSaveOwnDelivery(res, params);
        default:
            log('    [мок] НЕИЗВЕСТНАЯ серверная команда: ' + fnName);
            return rpcError(res, 'PGRST202', 'Could not find the function public.' + fnName);
    }
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

    // ---- Серверные команды (RPC, v2.8.0) ----
    // Заявки и деньги создаёт БАЗА одной командой, прямая запись в orders и
    // cash_requests базой закрыта. Поэтому мок отвечает вместо функций из
    // database/migrate-v2.8-finance-rpc-audit.sql — так же, как база: номер
    // под «блокировкой», заявка и позиции, обе операции выдачи.
    if (p.includes('/rest/v1/rpc/')) {
        return handleRpc(decodeURIComponent(p.split('/rest/v1/rpc/')[1]), payload, res);
    }

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
        // Страничная выдача: offset/limit ставит supabase-js для .range()
        // (js/database.js → selectPage). PostgREST режет список по ним, и мок
        // делает то же — иначе список «Снабжения» проверялся бы без страниц.
        const page = (list) => {
            const offset = params.offset !== undefined ? Number(params.offset) : 0;
            const limit = params.limit !== undefined ? Number(params.limit) : list.length;
            return list.slice(offset, offset + limit);
        };

        return sendJson(res, 200, page(rows));
    }

    if (req.method === 'POST') {
        const rows = Array.isArray(payload) ? payload : [payload];

        // С v2.8.0 INSERT в эти таблицы закрыт базой: заявки создаёт серверная
        // команда. Если приложение пишет сюда напрямую — прогон это покажет.
        if (table === 'orders' || table === 'cash_requests') {
            directInserts.push('POST /' + table + ': ' + JSON.stringify(payload).slice(0, 160));
            log('    [мок] ⚠ ПРЯМАЯ ЗАПИСЬ в ' + table + ' — база её запрещает, нужна серверная команда');
        }

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

        // Заявки на материалы: прораб убирает отработанную заявку в архив
        // (js/modules/orders.js → archiveOrder), поэтому мок должен уметь
        // сохранять статус — иначе «архив» выглядел бы рабочим в интерфейсе,
        // но в «базе» ничего не менялось.
        if (table === 'orders') {
            store.orders.forEach((row) => {
                if (ids.length && !ids.includes(row.id)) return;
                Object.assign(row, payload);
                updated.push(row);
                log('    [мок] UPDATE orders #' + row.id + ' (' + row.request_number + ') → status=' + row.status);
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

    PROFILE = prepareProfile(PROFILE);
    const started = await launchChrome({ port: CDP_PORT, profile: PROFILE, label: 'workflow' });
    chrome = started.child;
    log('  Chrome: ' + started.browser + ' (' + started.mode + ')');

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

    // ---------------------- 8. Прораб видит результат и фильтры ----------------------
    await loginAs(7, 'Прораб');
    dash = await blockText();
    ok('прораб видит, что деньги выданы', dash.includes('Выдано') && dash.includes('Ф-1/26'));

    // Фильтры блока «💰 Мои заявки на финансирование». Раньше отклонённая заявка
    // просто исчезала с рабочего экрана, и прораб не понимал, куда она делась.
    // Теперь у каждой стадии свой фильтр, а в нём — заявка и причина отказа.
    const financeFilterUi = await evaluate('(() => {' +
        'const chips = Array.prototype.filter.call(document.querySelectorAll(\"#dash-block-finance-body button\"),' +
        ' (b) => b.id.indexOf(\"dash-block-finance-filter-\") === 0)' +
        ' .map((b) => b.id.replace(\"dash-block-finance-filter-\", \"\") + \"=\" + b.innerText.trim());' +
        'return { chips: chips.join(\", \"),' +
        ' body: (document.getElementById(\"dash-block-finance-body\") || {}).innerText || \"\" }; })()');
    ok('у блока заявок на финансирование есть фильтры по всем статусам',
        ['pending', 'approved', 'revision', 'rejected', 'issued']
            .every((id) => financeFilterUi.chips.includes(id + '=')),
        financeFilterUi.chips);
    ok('в фильтре «Все» видна и отклонённая заявка (со статусом директора)',
        financeFilterUi.body.includes('Ф-2/26') && financeFilterUi.body.includes('Отклонено директором'),
        financeFilterUi.body.replace(/\n/g, ' | ').slice(0, 200));

    await evaluate('window.setMyFinanceFilter(\"rejected\")');
    await sleep(400);
    const financeRejected = await evaluate('(document.getElementById(\"dash-block-finance-body\") || {}).innerText || \"\"');
    ok('фильтр «❌ Отклонены» показывает заявку с причиной отказа и не показывает выданную',
        financeRejected.includes('Ф-2/26') && financeRejected.includes('Дублирует заявку Ф-1/26') &&
        !financeRejected.includes('🟢 Выдано'),
        financeRejected.replace(/\n/g, ' | ').slice(0, 200));

    await evaluate('window.setMyFinanceFilter(\"issued\")');
    await sleep(400);
    const financeIssued = await evaluate('(document.getElementById(\"dash-block-finance-body\") || {}).innerText || \"\"');
    ok('фильтр «🟢 Выданы» показывает выданную заявку и не показывает отклонённую',
        financeIssued.includes('Ф-1/26') && financeIssued.includes('🟢 Выдано') &&
        !financeIssued.includes('Ф-2/26'),
        financeIssued.replace(/\n/g, ' | ').slice(0, 200));

    await evaluate('window.setMyFinanceFilter(\"pending\")');
    await sleep(400);
    const financePending = await evaluate('(document.getElementById(\"dash-block-finance-body\") || {}).innerText || \"\"');
    ok('фильтр «⏳ Поданы» пуст: директор уже обработал обе заявки',
        financePending.includes('Заявок на согласовании у директора нет'),
        financePending.replace(/\n/g, ' | ').slice(0, 160));

    await evaluate('window.setMyFinanceFilter(\"all\")');
    await sleep(300);

    // Фильтры блока «📦 Мои заявки на материалы»: у прораба три закупки —
    // З-11/26 (🔴 Новая) и З-12/26 (🟡 В обработке) поданы в снабжение,
    // З-13/26 (🚚 Доставлено на объект) уже привезли.
    const materialsFilterUi = await evaluate('(() => {' +
        'const chips = Array.prototype.filter.call(document.querySelectorAll(\"#dash-block-materials-body button\"),' +
        ' (b) => b.id.indexOf(\"dash-block-materials-filter-\") === 0)' +
        ' .map((b) => b.id.replace(\"dash-block-materials-filter-\", \"\") + \"=\" + b.innerText.trim());' +
        'return chips.join(\", \"); })()');
    ok('у блока заявок на материалы есть фильтры «Поданы в снабжение» и «Доставлено на объект»',
        materialsFilterUi.includes('supply=📤 Поданы в снабжение') &&
        materialsFilterUi.includes('delivered=🚚 Доставлено на объект'),
        materialsFilterUi);
    ok('счётчики фильтров посчитаны по своим этапам закупки',
        materialsFilterUi.includes('Поданы в снабжение (2)') && materialsFilterUi.includes('Доставлено на объект (1)'),
        materialsFilterUi);

    const materialsAll = await evaluate('(document.getElementById(\"dash-block-materials-body\") || {}).innerText || \"\"');
    ok('в фильтре «Все» видны все три заявки на материалы',
        ['З-11/26', 'З-12/26', 'З-13/26'].every((number) => materialsAll.includes(number)),
        materialsAll.replace(/\n/g, ' | ').slice(0, 200));

    // Карточка заявки на материалы: суммы в списке нет (цену вносит снабженец
    // при доставке), зато нажимается вся карточка и открывает подробную
    // карточку заявки из «Снабжения» — состав, поставщик, даты, оплата счёта.
    ok('в списке заявок на материалы нет сумм',
        !materialsAll.includes('грн'),
        materialsAll.replace(/\n/g, ' | ').slice(0, 200));

    const materialsCards = await evaluate('(() => {' +
        'const cards = Array.prototype.filter.call(document.querySelectorAll(\"#dash-block-materials-body button\"),' +
        ' (b) => (b.getAttribute(\"data-action\") || \"\") === \"openOrderDetail\");' +
        'return { count: cards.length, text: cards.map((c) => c.innerText.trim()).join(\" || \") }; })()');
    ok('каждая карточка заявки кликабельна целиком (3 заявки — 3 карточки)',
        materialsCards.count === 3, JSON.stringify(materialsCards).slice(0, 220));

    await evaluate('(() => {' +
        'const card = Array.prototype.filter.call(document.querySelectorAll(\"#dash-block-materials-body button\"),' +
        ' (b) => b.getAttribute(\"data-action\") === \"openOrderDetail\" && b.getAttribute(\"data-arg\") === \"903\")[0];' +
        'if (card) card.click();' +
        'return !!card; })()');
    await sleep(900);
    const orderDetailCard = await evaluate('(() => ({' +
        ' hidden: document.getElementById(\"order-detail-modal\").classList.contains(\"hidden\"),' +
        ' text: (document.getElementById(\"order-detail-content\") || {}).innerText || \"\" }))()');
    ok('нажатие на карточку открывает подробную карточку заявки: состав, поставщик, суммы',
        !orderDetailCard.hidden &&
        ['З-13/26', 'Стройбаза Одесса', 'Цемент М400', 'Песок', 'грн']
            .every((part) => orderDetailCard.text.includes(part)),
        orderDetailCard.text.replace(/\n/g, ' | ').slice(0, 400));

    await evaluate('hideModal(\"order-detail-modal\")');
    await sleep(300);

    await evaluate('window.setMyMaterialsFilter(\"supply\")');
    await sleep(400);
    const materialsSupply = await evaluate('(document.getElementById(\"dash-block-materials-body\") || {}).innerText || \"\"');
    ok('фильтр «📤 Поданы в снабжение» показывает новые и взятые в работу, но не доставленные',
        materialsSupply.includes('З-11/26') && materialsSupply.includes('З-12/26') &&
        !materialsSupply.includes('З-13/26'),
        materialsSupply.replace(/\n/g, ' | ').slice(0, 200));

    await evaluate('window.setMyMaterialsFilter(\"delivered\")');
    await sleep(400);
    const materialsDelivered = await evaluate('(document.getElementById(\"dash-block-materials-body\") || {}).innerText || \"\"');
    ok('фильтр «🚚 Доставлено на объект» показывает только доставленную заявку',
        materialsDelivered.includes('З-13/26') && materialsDelivered.includes('🚚 Доставлено на объект') &&
        !materialsDelivered.includes('З-11/26'),
        materialsDelivered.replace(/\n/g, ' | ').slice(0, 200));

    await evaluate('window.setMyMaterialsFilter(\"all\")');
    await sleep(300);

    // ---------------------- 9. Архив: автор убирает отработанное ----------------------
    // У обоих блоков рабочего экрана есть фильтр «📥 Архив». Карточка заявки на
    // финансирование нажимается целиком и открывает подробное окно, а кнопка
    // «📥 В архив» живёт в этом окне — там же, где она есть у снабженца.
    const archiveChips = await evaluate('(() => {' +
        'const chip = (block, id) => { const el = document.getElementById(block + "-filter-" + id); return el ? el.innerText.trim() : ""; };' +
        'return { finance: chip("dash-block-finance", "archived"), materials: chip("dash-block-materials", "archived") }; })()');
    ok('у блока заявок на финансирование есть фильтр «📥 Архив»',
        archiveChips.finance.includes('📥 Архив'), archiveChips.finance);
    ok('у блока заявок на материалы есть фильтр «📥 Архив»',
        archiveChips.materials.includes('📥 Архив'), archiveChips.materials);

    const financeCardsClickable = await evaluate('(() => {' +
        'const cards = Array.prototype.filter.call(document.querySelectorAll("#dash-block-finance-body [role=button]"),' +
        ' (el) => (el.getAttribute("data-action") || "") === "openCashRequestDetail");' +
        'return { count: cards.length, text: cards.map((c) => c.innerText.trim()).join(" || ") }; })()');
    ok('карточка заявки на финансирование нажимается целиком (2 заявки — 2 карточки)',
        financeCardsClickable.count === 2, JSON.stringify(financeCardsClickable).slice(0, 240));

    // Карточку ищем по НОМЕРУ заявки: в тексте карточки «❌ Отклонено» стоит
    // причина отказа, и в ней может упоминаться номер другой заявки
    // («Дублирует заявку Ф-1/26») — по тексту карточка выбиралась бы не та.
    const clickFinanceCard = (number) => evaluate('(() => {' +
        'const cards = Array.prototype.filter.call(document.querySelectorAll("#dash-block-finance-body [role=button]"),' +
        ' (el) => (el.getAttribute("data-action") || "") === "openCashRequestDetail");' +
        'const card = cards.filter((el) => { const n = el.querySelector("span.font-mono");' +
        ' return !!n && n.innerText.trim() === "' + number + '"; })[0];' +
        'if (card) card.click();' +
        'return !!card; })()');

    ok('карточка выданной заявки нажимается целиком', await clickFinanceCard('Ф-1/26'));
    await sleep(800);
    const financeDetailCard = await evaluate('(() => ({' +
        ' number: (document.querySelector("#cash-request-detail-content span.font-mono") || {}).innerText || "",' +
        ' hidden: document.getElementById("cash-request-detail-modal").classList.contains("hidden"),' +
        ' text: (document.getElementById("cash-request-detail-content") || {}).innerText || "" }))()');
    ok('в окне открылась именно та заявка, на карточку которой нажали',
        financeDetailCard.number.trim() === 'Ф-1/26', financeDetailCard.number);
    ok('в подробном окне видно состав заявки, объект и раздел',
        !financeDetailCard.hidden &&
        ['Кладка стен', 'Кладочные работы', 'грн']
            .every((part) => financeDetailCard.text.includes(part)),
        financeDetailCard.text.replace(/\n/g, ' | ').slice(0, 240));

    const financeArchiveButton = await evaluate('(() => {' +
        'const btns = Array.prototype.slice.call(document.querySelectorAll("#cash-request-detail-actions button"));' +
        'return { all: btns.map((b) => b.innerText.trim()).join(", "),' +
        ' count: btns.filter((b) => b.innerText.indexOf("В архив") >= 0).length }; })()');
    ok('в подробном окне выданной заявки есть у автора кнопка «📥 В архив»',
        financeArchiveButton.count === 1, financeArchiveButton.all);

    const issuedSumBefore = Number(requestA.total_sum);
    await evaluate('window.confirm = () => true');
    await evaluate('(() => {' +
        'const btn = Array.prototype.slice.call(document.querySelectorAll("#cash-request-detail-actions button"))' +
        ' .filter((b) => b.innerText.indexOf("В архив") >= 0)[0];' +
        'if (btn) btn.click();' +
        'return !!btn; })()');
    await sleep(2200);
    ok('выданная заявка ушла в архив (в базе status = archived)',
        requestA.status === 'archived', 'status=' + requestA.status);
    ok('заявка осталась в базе со своей суммой (архив — не удаление)',
        !!REQUEST_OF('Ф-1/26') && Number(REQUEST_OF('Ф-1/26').total_sum) === issuedSumBefore,
        REQUEST_OF('Ф-1/26') ? 'сумма=' + REQUEST_OF('Ф-1/26').total_sum : 'заявки нет');

    await evaluate('window.setMyFinanceFilter("archived")');
    await sleep(500);
    const financeArchiveBody = await evaluate('(document.getElementById("dash-block-finance-body") || {}).innerText || ""');
    ok('фильтр «📥 Архив» показывает убранную заявку со статусом «📥 В архиве»',
        financeArchiveBody.includes('Ф-1/26') && financeArchiveBody.includes('📥 В архиве'),
        financeArchiveBody.replace(/\n/g, ' | ').slice(0, 200));

    await evaluate('window.setMyFinanceFilter("issued")');
    await sleep(400);
    const financeIssuedAfter = await evaluate('(document.getElementById("dash-block-finance-body") || {}).innerText || ""');
    ok('из «🟢 Выданы» убранная заявка исчезла',
        !financeIssuedAfter.includes('Ф-1/26') && financeIssuedAfter.includes('Выданных заявок нет'),
        financeIssuedAfter.replace(/\n/g, ' | ').slice(0, 200));

    await evaluate('window.setMyFinanceFilter("all")');
    await sleep(300);

    // Заявка на материалы: карточку доставленной заявки открываем из блока и
    // убираем в архив кнопкой в подробной карточке — её видит автор заявки.
    await evaluate('(() => {' +
        'const card = Array.prototype.filter.call(document.querySelectorAll("#dash-block-materials-body button"),' +
        ' (b) => b.getAttribute("data-action") === "openOrderDetail" && b.getAttribute("data-arg") === "903")[0];' +
        'if (card) card.click();' +
        'return !!card; })()');
    await sleep(900);

    const orderArchiveButton = await evaluate('(() => {' +
        'const btns = Array.prototype.slice.call(document.querySelectorAll("#order-detail-actions button"));' +
        'return { all: btns.map((b) => b.innerText.trim()).join(", "),' +
        ' count: btns.filter((b) => b.innerText.indexOf("В архив") >= 0).length }; })()');
    ok('прораб видит в карточке доставленной заявки кнопку «📥 В архив»',
        orderArchiveButton.count === 1, orderArchiveButton.all);

    await evaluate('window.confirm = () => true');
    await evaluate('(() => {' +
        'const btn = Array.prototype.slice.call(document.querySelectorAll("#order-detail-actions button"))' +
        ' .filter((b) => b.innerText.indexOf("В архив") >= 0)[0];' +
        'if (btn) btn.click();' +
        'return !!btn; })()');
    await sleep(2200);
    const order903 = () => store.orders.find((o) => o.id === 903);
    ok('доставленная заявка на материалы ушла в архив',
        order903().status === 'archived', 'status=' + order903().status);

    await evaluate('window.setMyMaterialsFilter("archived")');
    await sleep(500);
    const materialsArchiveBody = await evaluate('(document.getElementById("dash-block-materials-body") || {}).innerText || ""');
    ok('фильтр «📥 Архив» показывает убранную заявку на материалы',
        materialsArchiveBody.includes('З-13/26') && materialsArchiveBody.includes('📥 Архив'),
        materialsArchiveBody.replace(/\n/g, ' | ').slice(0, 200));

    await evaluate('window.setMyMaterialsFilter("delivered")');
    await sleep(400);
    const materialsDeliveredAfter = await evaluate('(document.getElementById("dash-block-materials-body") || {}).innerText || ""');
    ok('из «🚚 Доставлено на объект» убранная заявка исчезла',
        !materialsDeliveredAfter.includes('З-13/26'),
        materialsDeliveredAfter.replace(/\n/g, ' | ').slice(0, 160));

    // Рабочую заявку в архив не пускаем: «Поданы в снабжение» ещё не отработаны
    await evaluate('window.archiveOrder(901)');
    await sleep(900);
    ok('рабочую заявку в архив не пускает (только доставленную или закрытую)',
        store.orders.find((o) => o.id === 901).status === 'new',
        'status=' + store.orders.find((o) => o.id === 901).status);

    await evaluate('window.setMyMaterialsFilter("all")');
    await sleep(300);

    // УКРАИНСКИЙ ЯЗЫК В ЖИВОМ БРАУЗЕРЕ. Язык переключается так же, как в окне
    // настроек (js/i18n.js → setLang), и переводится не только разметка, но и
    // то, что модули дописали себе сами: заголовки блоков, фильтры, статусы,
    // подписи карточек. Именно здесь ловится исходная жалоба «часть надписей
    // осталась русской» — надпись есть в модуле, а пары для неё в словаре нет.
    // ВАЖНО: этот блок идёт последним — он меняет язык открытой страницы.
    await evaluate('(() => { window.i18n.setLang("uk"); return window.i18n.getLang(); })()');
    await sleep(1500);
    const ukText = await evaluate('document.body.innerText || ""');
    try {
        const dir = path.join(os.tmpdir(), 'rsk-fin');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'fin-workflow-uk.txt'), ukText, 'utf8');
    } catch { /* отчёт не критичен */ }

    const ruLeft = ['Задания от руководства', 'Только ваши', 'Мои заявки на финансирование',
        'Мои заявки на материалы', 'Создать заявку', 'Деньги зачислены', 'Раздел:']
        .filter((s) => ukText.includes(s));
    const ukSeen = ['Завдання від керівництва', 'Лише ваші завдання', 'Мої заявки', 'Створити заявку',
        'Детальніше', 'Архів'].filter((s) => ukText.includes(s));
    log('--- украинский язык в живом браузере ---');
    log('  русские надписи, которые остались: ' + (ruLeft.length ? ruLeft.join(' | ') : 'нет'));
    log('  украинские надписи на месте: ' + (ukSeen.length ? ukSeen.join(' | ') : 'нет'));
    ok('после переключения языка рабочий экран полностью украинский',
        ruLeft.length === 0 && ukSeen.length >= 4,
        'осталось: ' + (ruLeft.join(', ') || 'ничего'));

    log('--- ИТОГ ---');
    ok('заявки создаются серверной командой, а не прямой записью в таблицу',
        directInserts.length === 0,
        directInserts.join(' | '));
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
