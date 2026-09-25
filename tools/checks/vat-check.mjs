// =====================================================================
// Прогон БЕЗ БРАУЗЕРА (только Node): НДС и своя доставка в счетах
// =====================================================================
// Зачем: у счёта поставщика два места, где ошибка видна не сразу, а в деньгах.
//
//   1. НДС (ПДВ) не должен прибавляться дважды. Галочки «+20 %» в приложении
//      нет намеренно: снабженец выбирает РЕЖИМ ввода (orders.invoice_price_mode)
//      — «цены уже с ПДВ» / «цены без ПДВ», — а налог считает ТОЛЬКО
//      js/utils.js → calcVat(). В режиме «уже с ПДВ» налог ВЫДЕЛЯЕТСЯ из
//      введённой суммы, в режиме «без ПДВ» — добавляется сверху ровно один раз.
//      Деньги в order_items (unit_price / total_price) всегда хранятся С НДС,
//      а vat_amount лишь показывает, сколько налога внутри. Если кто-то вернёт
//      галочку и начнёт умножать сумму на 1,2 — поставщику уйдёт лишнее;
//      прогон ловит это и на математике, и по коду.
//
//   2. Своя доставка — это НЕ оплата внешнему поставщику. Деньги уходят своим:
//      с подотчёта снабженца, с подотчёта другого сотрудника (водитель,
//      транспортный отдел) или безналом фирмы; в счёт поставщика сумма не
//      входит. Когда платят из подотчёта, расход ставит БАЗА одной командой
//      (v2.8.0 → save_own_delivery_expense, маркер source = 'own_delivery'),
//      и тогда строка заявки из ДЕНЕГ не считается — иначе сумма попала бы в
//      план-факт, реестр и «Доп. расходы» дважды. Прогон стережёт, что браузер
//      не вернулся к прямой записи кассы: два одновременных сохранения счёта
//      создавали два расхода на одну заявку.
//
// Прогон вызывает НАСТОЯЩИЕ функции приложения (js/utils.js) — это не копия
// формул, а тот же код, что считает счёт в браузере, — и стережёт договор
// файлов между собой: CONFIG ↔ разметка (index.html) ↔ orders.js ↔ миграции
// базы (v2.5.0 и v2.8.0) ↔ подсказка при непройденной миграции
// (js/database.js → explainError) ↔ словарь языков.
//
// Запуск (из папки tools/checks):  node vat-check.mjs
// Код возврата 1, если есть замечания — удобно для автопроверки перед выкладкой.
// =====================================================================
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = process.env.APP_ROOT
    ? path.resolve(process.env.APP_ROOT)
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const report = [];
const log = (...args) => { const line = args.join(' '); report.push(line); console.log(line); };

let failed = 0;
const ok = (name, cond, extra = '') => {
    log((cond ? '  ok   ' : '  FAIL ') + name + (extra ? ' :: ' + extra : ''));
    if (!cond) failed += 1;
};

const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
const rel = (full) => path.relative(ROOT, full).replace(/\\/g, '/');
const count = (text, needle) => text.split(needle).length - 1;

// js/config.js и js/utils.js написаны для браузера: config.js сразу создаёт
// клиент Supabase, utils.js вешает обработчики сети и клавиатуры. Подставляем
// минимум, чтобы модули загрузились и их функции можно было вызвать напрямую.
globalThis.window = globalThis.window || {
    addEventListener() {},
    supabase: { createClient: () => ({}) }
};
globalThis.document = globalThis.document || {
    addEventListener() {},
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => []
};
try {
    // В свежих Node (21+) navigator уже есть и объявлен только для чтения:
    // подставить своё значение нельзя, но и не нужно — isOnline() не вызывается.
    globalThis.navigator = globalThis.navigator || { onLine: true };
} catch { /* navigator только для чтения — это нормально */ }

/** Загружает модуль приложения, не засоряя отчёт его служебным логом. */
async function loadModule(...parts) {
    const url = pathToFileURL(path.join(ROOT, ...parts)).href;
    const saveLog = console.log;
    console.log = () => {};
    try {
        return await import(url);
    } finally {
        console.log = saveLog;
    }
}

/** Все файлы приложения (кроме проверок) — там ищем «ручной» НДС. */
function jsFiles(dir = path.join(ROOT, 'js')) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...jsFiles(full));
        else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out;
}

/** Кусок разметки между двумя строками-маркерами ('' — если маркеров нет). */
function sliceBetween(html, from, to) {
    const start = html.indexOf(from);
    if (start === -1) return '';
    const end = html.indexOf(to, start);
    return end === -1 ? '' : html.slice(start, end);
}

/** Значения атрибутов value="..." внутри разметки. */
function valuesOf(html) {
    return [...html.matchAll(/value="([^"]*)"/g)].map(m => m[1]);
}

const sortedList = (arr) => [...arr].map(String).sort().join(', ');

// Колонки, которые приносит v2.5.0 (миграция + database/schema.sql).
const V25_COLUMNS = [
    ['orders', 'invoice_price_mode'],
    ['orders', 'invoice_vat_rate'],
    ['orders', 'vat_total'],
    ['orders', 'own_delivery_charge'],
    ['orders', 'own_delivery_employee_id'],
    ['orders', 'own_delivery_vat_rate'],
    ['order_items', 'vat_rate'],
    ['order_items', 'vat_amount'],
    ['order_items', 'price_with_vat'],
    ['order_items', 'delivery_kind'],
    ['cash_operations', 'vat_rate'],
    ['cash_operations', 'vat_amount']
];

// Подписи, без которых снабженец (и финансист в реестре) не поймёт, что видит.
const I18N_KEYS = [
    'order.invoiceVatTitle',
    'order.invoiceVatModeWith',
    'order.invoiceVatModeWithout',
    'order.invoiceVatRate',
    'order.invoiceVatHint',
    'order.invoiceVatAmount',
    'order.invoiceVatBase',
    'order.invoiceOwnChargeTitle',
    'order.invoiceOwnChargeSnagach',
    'order.invoiceOwnChargeEmployee',
    'order.invoiceOwnChargeFirm',
    'order.invoiceOwnEmployeeHint',
    'order.invoiceOwnDeliveryVat',
    'order.invoiceDeliveryCompanyHint'
];


async function main() {
    const utils = await loadModule('js', 'utils.js');
    const { CONFIG } = await loadModule('js', 'config.js');

    const indexHtml = read('index.html');
    const ordersJs = read('js', 'modules', 'orders.js');
    const i18n = read('js', 'i18n.js');
    const migration = read('database', 'migrate-v2.5.sql');
    const migrationV28 = read('database', 'migrate-v2.8-finance-rpc-audit.sql');
    const schema = read('database', 'schema.sql');

    const MODE = CONFIG.VAT.MODE;
    const CHARGE = CONFIG.DELIVERY_ITEM.CHARGE;
    const TYPE = CONFIG.DELIVERY_ITEM.TYPE;

    log('Прогон: НДС и своя доставка (версия приложения ' + CONFIG.APP.VERSION + ')');

    // --- 0. Точки входа ---
    log('--- 0. Функции расчёта на месте ---');
    ok('налог считают функции приложения (utils.calcVat / utils.vatFromTotal), а не разметка',
        typeof utils.calcVat === 'function' && typeof utils.vatFromTotal === 'function' &&
        typeof utils.normalizeVatRate === 'function');

    // --- 1. НДС: начисление ровно один раз ---
    log('--- 1. НДС: налог не прибавляется дважды ---');

    const inside = utils.calcVat(1200, 20, true);
    ok('режим «цены уже с ПДВ»: налог ВЫДЕЛЯЕТСЯ, итог не растёт',
        inside.total === 1200 && inside.vat === 200 && inside.base === 1000,
        'итог ' + inside.total + ', в т.ч. ПДВ ' + inside.vat + ', без ПДВ ' + inside.base);

    const onTop = utils.calcVat(1000, 20, false);
    ok('режим «цены без ПДВ»: налог добавлен СВЕРХУ ровно один раз',
        onTop.total === 1200 && onTop.vat === 200,
        'итог ' + onTop.total + ', в т.ч. ПДВ ' + onTop.vat);

    const resaved = utils.calcVat(onTop.total, 20, true);
    ok('пересохранение счёта не начисляет налог второй раз',
        resaved.total === 1200 && resaved.vat === 200,
        'после пересохранения итог ' + resaved.total + ' (ожидалось 1200; «дважды» дало бы 1440)');

    const free = utils.calcVat(500, 0, false);
    ok('ставка 0 % — налога нет, сумма не меняется',
        free.vat === 0 && free.total === 500 && free.base === 500,
        'итог ' + free.total + ', ПДВ ' + free.vat);

    const bad = [];
    for (const rate of [0, 7, 20, 20.5, 100]) {
        for (const amount of [0.01, 1, 33.33, 1200, 99999.99]) {
            for (const withVat of [true, false]) {
                const r = utils.calcVat(amount, rate, withVat);
                if (money(r.base + r.vat) !== money(r.total)) {
                    bad.push(amount + ' @ ' + rate + '%: ' + r.base + '+' + r.vat + '≠' + r.total);
                }
                if (withVat && money(r.total) !== money(amount)) {
                    bad.push(amount + ' @ ' + rate + '%: сумма с налогом выросла до ' + r.total);
                }
                if (!withVat && rate > 0 && money(r.vat) > 0 && money(r.total) <= money(amount)) {
                    bad.push(amount + ' @ ' + rate + '%: налог не добавлен');
                }
            }
        }
    }
    ok('base + vat === total до копейки, «с ПДВ» не меняет сумму, «без ПДВ» её увеличивает',
        bad.length === 0, bad.slice(0, 3).join(' | '));

    ok('vatFromTotal ВЫДЕЛЯЕТ налог из готовой суммы (начисление «сверху» дало бы 290)',
        utils.vatFromTotal(1450, 20) === 241.67 &&
        money(1450 - utils.vatFromTotal(1450, 20)) === 1208.33,
        'ПДВ ' + utils.vatFromTotal(1450, 20));

    ok('ставка нормализуется: пусто/мусор/минус → 0, выше 100 → 100',
        utils.normalizeVatRate('') === 0 && utils.normalizeVatRate(null) === 0 &&
        utils.normalizeVatRate('мусор') === 0 && utils.normalizeVatRate(-5) === 0 &&
        utils.normalizeVatRate('20') === 20 && utils.normalizeVatRate(150) === 100,
        '"" → ' + utils.normalizeVatRate('') + ", '20' → " + utils.normalizeVatRate('20') +
        ', 150 → ' + utils.normalizeVatRate(150));

    ok('режим по умолчанию — безопасный («цены уже с ПДВ»), а не «налог сверху»',
        CONFIG.VAT.DEFAULT_MODE === MODE.WITH_VAT && MODE.WITH_VAT !== MODE.WITHOUT_VAT,
        'DEFAULT_MODE = ' + CONFIG.VAT.DEFAULT_MODE);

    // --- 2. Своя доставка: расход считается один раз ---
    log('--- 2. Своя доставка: внутренний расход, а не оплата поставщику ---');

    const covered = utils.ownDeliveryCoveredOrderIds([
        { source: 'own_delivery', order_id: 900 },
        { source: 'manual', order_id: 901 },
        { source: 'own_delivery' }
    ]);
    ok("маркер source = 'own_delivery' собирает заявки (bigint приходит строкой)",
        covered.size === 1 && covered.has('900'), 'заявок: ' + covered.size);

    const ownItem = { order_id: 900, name: 'Кирпич', delivery_kind: TYPE.COMPANY };
    const supplierItem = { order_id: 900, name: 'Кирпич', delivery_kind: TYPE.SUPPLIER };

    ok('своя доставка, оплаченная подотчётом, из денег заявки ИСКЛЮЧАЕТСЯ',
        utils.isOwnDeliveryCovered(ownItem, covered) === true);
    ok('доставка поставщика из денег НЕ исключается — она уже внутри счёта',
        utils.isOwnDeliveryCovered(supplierItem, covered) === false);
    ok('своя доставка по неоплаченной заявке показывается как «🏢 Вне счёта»',
        utils.isOwnDeliveryCovered({ order_id: 901, delivery_kind: TYPE.COMPANY }, covered) === false);
    ok('обычная позиция заявки под проверку не попадает',
        utils.isOwnDeliveryCovered({ order_id: 900, delivery_kind: null }, covered) === false);

    ok('вид доставки читается из колонки delivery_kind (имя строки больше не решает)',
        utils.getDeliveryItemType(ownItem) === TYPE.COMPANY &&
        utils.getDeliveryItemType(supplierItem) === TYPE.SUPPLIER &&
        utils.getDeliveryItemType({ name: 'Кирпич' }) === null);
    ok('строки доставки, созданные до v2.5.0, распознаются по имени',
        utils.getDeliveryItemType({ name: CONFIG.DELIVERY_ITEM.NAME }) === TYPE.SUPPLIER &&
        utils.getDeliveryItemType({ name: CONFIG.DELIVERY_ITEM.COMPANY_NAME }) === TYPE.COMPANY &&
        utils.isDeliveryItem({ name: ' доставка компании ' }) === true);
    ok('имена строк доставки берутся из CONFIG (одно место, без дублей текста)',
        utils.getDeliveryItemName(TYPE.COMPANY) === CONFIG.DELIVERY_ITEM.COMPANY_NAME &&
        utils.getDeliveryItemName(TYPE.SUPPLIER) === CONFIG.DELIVERY_ITEM.NAME &&
        CONFIG.DELIVERY_ITEM.NAME !== CONFIG.DELIVERY_ITEM.COMPANY_NAME);

    // --- 3. Разметка и CONFIG согласованы ---
    log('--- 3. Разметка окна счёта и CONFIG согласованы ---');

    const vatBlock = sliceBetween(indexHtml, 'name="order-invoice-vat-mode"', 'id="order-invoice-vat-rates"');
    const modeValues = [...vatBlock.matchAll(/name="order-invoice-vat-mode"\s+value="([^"]+)"/g)].map(m => m[1]);
    ok('режимы ПДВ в разметке — те же два, что в CONFIG.VAT.MODE',
        modeValues.length === 2 && sortedList(modeValues) === sortedList(Object.values(MODE)),
        'в разметке: ' + modeValues.join(', '));
    ok('по умолчанию отмечен безопасный режим «цены уже с ПДВ»',
        new RegExp('id="order-invoice-vat-mode-with"\\s+checked').test(vatBlock));

    const vatRateTag = (vatBlock.match(/<input[^>]*id="order-invoice-vat-rate"[^>]*>/) || [''])[0];
    ok('поле ставки НДС: границы 0…100 и значение по умолчанию из CONFIG',
        vatRateTag.includes('min="0"') && vatRateTag.includes('max="100"') &&
        vatRateTag.includes('value="' + CONFIG.VAT.DEFAULT_RATE + '"'),
        vatRateTag.replace(/\s+/g, ' ').slice(0, 60));
    ok('подсказки ставки (0 / 7 / 20) заполняются из CONFIG.VAT.RATES',
        /id="order-invoice-vat-rates"/.test(indexHtml) && /CONFIG\.VAT\??\.RATES/.test(ordersJs));
    ok('в разметке НЕТ галочки «начислить НДС» — только выбор режима цены',
        !/<input[^>]*type="checkbox"[^>]*id="[^"]*vat/i.test(indexHtml) &&
        !/<input[^>]*id="[^"]*vat[^"]*"[^>]*type="checkbox"/i.test(indexHtml));
    ok('в окне счёта есть расшифровка «в т.ч. ПДВ / без ПДВ» для бухгалтера',
        /id="order-invoice-vat-summary"/.test(indexHtml) &&
        /getElementById\('order-invoice-vat-summary'\)/.test(ordersJs));

    const deliveryBlock = sliceBetween(indexHtml, 'name="order-invoice-delivery-type"', 'id="order-invoice-own-charge-block"');
    const deliveryValues = [...deliveryBlock.matchAll(/name="order-invoice-delivery-type"\s+value="([^"]+)"/g)].map(m => m[1]);
    ok('выбор «чья доставка» предлагает оба вида из CONFIG.DELIVERY_ITEM.TYPE',
        deliveryValues.length === 2 && sortedList(deliveryValues) === sortedList(Object.values(TYPE)),
        'в разметке: ' + deliveryValues.join(', '));

    const chargeBlock = sliceBetween(indexHtml, 'id="order-invoice-own-charge"', '</select>');
    ok('варианты «чем списываем свою доставку» совпадают с CONFIG.DELIVERY_ITEM.CHARGE',
        valuesOf(chargeBlock).length === 3 &&
        sortedList(valuesOf(chargeBlock)) === sortedList(Object.values(CHARGE)),
        'в разметке: ' + valuesOf(chargeBlock).join(', '));
    ok('по умолчанию своя доставка списывается с подотчёта снабженца',
        Object.values(CHARGE).includes(CONFIG.DELIVERY_ITEM.DEFAULT_CHARGE) &&
        /chargeSelect\.value = order\.own_delivery_charge \|\| CONFIG\.DELIVERY_ITEM\.DEFAULT_CHARGE/.test(ordersJs),
        'DEFAULT_CHARGE = ' + CONFIG.DELIVERY_ITEM.DEFAULT_CHARGE);
    ok('для списания с чужого подотчёта есть выбор сотрудника',
        /id="order-invoice-own-employee"/.test(indexHtml) &&
        /CONFIG\.DELIVERY_ITEM\.CHARGE\.EMPLOYEE/.test(ordersJs));
    ok('у своей доставки своя ставка НДС (перевозка часто без налога)',
        /id="order-invoice-own-vat-rate"/.test(indexHtml) &&
        /const deliveryVatRate = companyDelivery \? ownVatRate : vatRate/.test(ordersJs));

    // --- 4. Код: где именно считается налог ---
    log('--- 4. Код: налог считается в одном месте ---');

    const vatFromTotalFiles = jsFiles()
        .filter(file => /vatFromTotal\s*\(/.test(fs.readFileSync(file, 'utf8')))
        .map(rel)
        .sort();
    ok('налог «из готовой суммы» считают только utils.js и сохранение счёта (orders.js)',
        vatFromTotalFiles.join(', ') === 'js/modules/orders.js, js/utils.js',
        vatFromTotalFiles.join(', '));

    const doubling = jsFiles().flatMap(file => fs.readFileSync(file, 'utf8').split(/\r?\n/)
        .map((line, i) => ({ file: rel(file), n: i + 1, text: line.trim() }))
        .filter(line => /(?:\*|\/)\s*1[.,]2\b/.test(line.text)));
    ok('в коде нет «ручного» +20 % (умножение на 1,2) — налог только через calcVat()',
        doubling.length === 0,
        doubling.map(x => x.file + ':' + x.n + ' ' + x.text.slice(0, 40)).join(' | '));

    ok('суммы позиций сохраняются С НДС: итог к оплате берётся из calcVat().total',
        /const payTotal = calcVat\(enteredTotal, vatRate, priceWithVat\)\.total/.test(ordersJs) &&
        /const priceWithVat = vatMode !== CONFIG\.VAT\.MODE\.WITHOUT_VAT/.test(ordersJs) &&
        /calcVat\(roundMoney\(qty \* price\), rate, withVat\)/.test(ordersJs));
    ok('расшифровка налога у позиции — ВЫДЕЛЕНИЕ из сохранённой суммы',
        /vatAmount: vatFromTotal\(savedTotalPrice, vatRate\)/.test(ordersJs) &&
        /vat_amount: vatFromTotal\(totalPrice, rowVatRate\)/.test(ordersJs));
    ok('НДС строки доставки выделяется из вписанной суммы (сверху не прибавляется)',
        /const vatAmount = vatFromTotal\(amount, vatRate\)/.test(ordersJs));
    ok('режим и ставка сохраняются вместе со счётом (повторный расчёт ничего не меняет)',
        /invoice_price_mode: vatMode/.test(ordersJs) &&
        /invoice_vat_rate: vatRate/.test(ordersJs) &&
        /getInvoiceVatRate\(\)/.test(ordersJs));

    // С v2.8.0 расход своей доставки ставит БАЗА одной командой под блокировкой:
    // повтор открывает окно и перечитывает счёт, поэтому расхода дважды не будет.
    ok("расход своей доставки заказывает команда save_own_delivery_expense (не прямая запись кассы)",
        /db\.rpc\(RPC\.SAVE_OWN_DELIVERY_EXPENSE, \{/.test(ordersJs) &&
        /p_order_id: order\.id,/.test(ordersJs) &&
        /p_enabled: !!company,/.test(ordersJs) &&
        /p_amount: amount,/.test(ordersJs) &&
        /p_charge: charge,/.test(ordersJs) &&
        /p_vat_rate: vatRate/.test(ordersJs) &&
        !/source: 'own_delivery'/.test(ordersJs),
        'в orders.js не осталось прямой записи расхода');
    ok('платит фирма, сумма очищена или доставки нет — прежний расход удаляет база',
        /p_enabled: !!company/.test(ordersJs) &&
        /if not coalesce\(p_enabled, false\)\s*\r?\n\s*or p_charge = 'firm'/.test(migrationV28) &&
        /delete from public\.cash_operations where id = old_operation\.id;/.test(migrationV28) &&
        /'action', case when has_old then 'deleted' else 'unchanged' end/.test(migrationV28));
    ok('сумма своей доставки в счёт поставщика не входит (и её НДС тоже)',
        /const invoiceTotal = companyDelivery \? materialsSum : totalSum/.test(ordersJs) &&
        /const vatTotal = companyDelivery\s*\? materialsVat/.test(ordersJs) &&
        /const totalSum = roundMoney\(materialsSum \+ deliveryAmount\)/.test(ordersJs));
    ok('списание с подотчёта другого сотрудника берёт его id из окна счёта',
        /getInvoiceOwnCharge\(\) === CONFIG\.DELIVERY_ITEM\.CHARGE\.EMPLOYEE && !ownEmployeeId/.test(ordersJs) &&
        /employeeId: ownEmployeeId/.test(ordersJs) &&
        /p_employee_id: employeeId \|\| null/.test(ordersJs) &&
        /if p_charge = 'employee' then\s*\r?\n\s*payer_id := p_employee_id;/.test(migrationV28));

    // Реестр с v2.9.0 считает свою доставку НЕ в браузере, а в виде базы
    // (database/migrate-v2.9-registry-view.sql): строка заявки уступает расходу
    // подотчёта прямо в SQL — иначе одна сумма попадала бы в деньги дважды.
    // Поэтому общая проверка js/utils.js нужна двум модулям, а третье место
    // (реестр) стережёт SQL.
    const moneyModules = ['cash.js', 'dashboard.js'].filter(name =>
        /ownDeliveryCoveredOrderIds\(|isOwnDeliveryCovered\(/.test(read('js', 'modules', name)));
    ok('план-факт подотчёта и дашборд пользуются общей проверкой своей доставки',
        moneyModules.length === 2, moneyModules.join(', '));

    const registryViewSql = read('database', 'migrate-v2.9-registry-view.sql');
    ok('реестр исключает строку своей доставки в ВИДЕ базы (сумма считается один раз)',
        /source = 'own_delivery'/.test(registryViewSql) &&
        /rsk_delivery_kind\([^)]*\) = 'company'/.test(registryViewSql) &&
        /exists \(/.test(registryViewSql) &&
        !/ownDeliveryCoveredOrderIds\(|isOwnDeliveryCovered\(/
            .test(read('js', 'modules', 'registry.js')));

    const helperOwners = jsFiles()
        .filter(file => /export function (ownDeliveryCoveredOrderIds|isOwnDeliveryCovered)\b/
            .test(fs.readFileSync(file, 'utf8')))
        .map(rel);
    ok('проверка «уже оплачено расходом» написана в одном месте (utils.js), а не в каждом модуле',
        helperOwners.join(', ') === 'js/utils.js', helperOwners.join(', '));

    // --- 5. База и словарь ---
    log('--- 5. База и словарь языков ---');

    const notListed = V25_COLUMNS.filter(([tbl, col]) => !migration.includes("('" + tbl + "', '" + col + "')"));
    ok('самопроверка миграции перечисляет все 12 колонок v2.5.0',
        V25_COLUMNS.length === 12 && notListed.length === 0,
        notListed.map(([t, c]) => t + '.' + c).join(', '));
    ok('колонки добавляются защищёнными блоками (add column if not exists + exception when others)',
        (migration.match(/add column if not exists/gi) || []).length >= 3 &&
        (migration.match(/exception when others/g) || []).length >= 3,
        'блоков: ' + (migration.match(/exception when others/g) || []).length);
    ok('миграция перечитывает схему PostgREST (notify pgrst)',
        /notify pgrst,\s*'reload schema'/.test(migration));
    ok('в самопроверке есть подсказка, что делать при MISSING',
        /MISSING — примените файл целиком/.test(migration));
    ok('schema.sql описывает те же колонки, что и миграция',
        V25_COLUMNS.every(([, col]) => new RegExp('\\b' + col + '\\b').test(schema)));
    ok('значения в базе совпадают с CONFIG (with_vat, snagach/employee/firm, supplier/company)',
        migration.includes("'" + CONFIG.VAT.DEFAULT_MODE + "'") &&
        Object.values(CHARGE).every(v => migration.includes("'" + v + "'")) &&
        Object.values(TYPE).every(v => migration.includes("'" + v + "'")));
    ok('старые строки доставки получают признак по имени (иначе сумму посчитают дважды)',
        migration.includes("set delivery_kind = 'supplier'") &&
        migration.includes("set delivery_kind = 'company'") &&
        migration.includes("name = 'Доставка компании'"));
    ok("код и база называют маркер расхода одинаково (source = 'own_delivery')",
        migrationV28.includes("source = 'own_delivery'") &&
        /op\.source === 'own_delivery'/.test(read('js', 'utils.js')) &&
        /category = 'delivery',/.test(migrationV28) &&
        /order_id = order_row\.id,/.test(migrationV28) &&
        /'delivery',\s*\r?\n\s*order_row\.project_id,/.test(migrationV28) &&
        /'own_delivery',\s*\r?\n\s*format\('Своя доставка по заявке %s'/.test(migrationV28),
        'расход привязан к заявке (order_id) и в новой, и в обновляемой строке');
    ok('браузер не пишет и не удаляет расход своей доставки сам (только команда базы)',
        !/db\.remove\('cash_operations'/.test(ordersJs) &&
        !/filters: \{ order_id: order\.id, source: 'own_delivery' \}/.test(ordersJs) &&
        /action: created \| updated \| deleted \| unchanged/.test(ordersJs));

    const halfTranslated = I18N_KEYS.filter(key => count(i18n, "'" + key + "':") < 2);
    ok('подписи НДС и своей доставки есть и в RU, и в UK',
        halfTranslated.length === 0,
        halfTranslated.length ? halfTranslated.join(', ') : 'ключей: ' + I18N_KEYS.length);
    const hintRu = i18n.slice(i18n.indexOf("'order.invoiceVatHint'"), i18n.indexOf("'order.invoiceVatAmount'"));
    ok('подсказка в окне счёта объясняет, что налог не добавляется второй раз',
        count(i18n, "'order.invoiceVatHint':") === 2 && /налог/i.test(hintRu));

    // --- 5б. На базу без новых колонок приложение должно назвать СВОЙ файл ---
    // Без этого снабженец на базе без v2.5.0 читал бы «примените
    // migrate-v2.4.sql», применял бы её и получал ту же ошибку второй раз:
    // колонки НДС и своей доставки приносит отдельный файл.
    log('--- 5б. Подсказка при непройденной миграции ---');

    const db = await loadModule('js', 'database.js');
    const dbJs = read('js', 'database.js');

    // Спрашиваем explainError() так, как это делает PostgREST, и смотрим, какой
    // файл он советует. Служебный лог приложения на время вопроса глушим.
    const askedFile = (column) => {
        const saveLog = console.log, saveWarn = console.warn, saveError = console.error;
        console.log = console.warn = console.error = () => {};
        try {
            return db.explainError({
                message: `Could not find the '${column}' column of 'orders' in the schema cache`
            });
        } finally {
            console.log = saveLog; console.warn = saveWarn; console.error = saveError;
        }
    };

    const v25Unique = [...new Set(V25_COLUMNS.map(([, col]) => col))];
    const wrongV25File = v25Unique.filter(col => !askedFile(col).includes('database/migrate-v2.5.sql'));
    ok('отсутствие колонки v2.5.0 ведёт к migrate-v2.5.sql, а не к v2.4.0',
        wrongV25File.length === 0,
        wrongV25File.length ? wrongV25File.join(', ') : 'проверено колонок: ' + v25Unique.length);

    // Список колонок v2.4.0 берём из самопроверки самой миграции (блок «8 ok»),
    // чтобы проверка не разошлась с файлом, который выполняют в базе.
    const v24Sql = read('database', 'migrate-v2.4.sql');
    const v24From = v24Sql.indexOf("from (values ('delivered_at')");
    const v24To = v24Sql.indexOf('as c(name)', v24From);
    const v24Columns = [...v24Sql.slice(v24From, v24To).matchAll(/\('([a-z_]+)'\)/g)].map(m => m[1]);
    const wrongV24File = v24Columns.filter(col => !askedFile(col).includes('database/migrate-v2.4.sql'));
    ok('колонки v2.4.0 по-прежнему ведут к migrate-v2.4.sql (подсказку не сломали)',
        v24Columns.length === 8 && wrongV24File.length === 0,
        'колонок из самопроверки: ' + v24Columns.length + (wrongV24File.length ? '; неверно: ' + wrongV24File.join(', ') : ''));

    ok('незнакомая колонка ведёт к базовой миграции v2.4.0 (файл не выдумывается)',
        askedFile('unknown_column_x').includes('database/migrate-v2.4.sql'));

    // Консольная подсказка должна называть версию НУЖНОЙ миграции, а не версию
    // приложения: при отсутствующей колонке v2.4.0 (payment_status) в консоли
    // стояло «база не обновлена под v2.5.0» — администратор правил не тот файл.
    // Сообщение печатается один раз за загрузку (schemaWarningShown), поэтому
    // берём свежий экземпляр модуля: import со своим URL — это новый модуль.
    const dbFresh = await import(
        pathToFileURL(path.join(ROOT, 'js', 'database.js')).href + '?console-hint'
    );
    const consoleHint = [];
    const saveConsoleError = console.error;
    console.error = (...args) => consoleHint.push(args.join(' '));
    try {
        dbFresh.explainError({
            message: "Could not find the 'payment_status' column of 'orders' in the schema cache"
        });
    } finally {
        console.error = saveConsoleError;
    }
    const hintText = consoleHint.join(' | ');
    ok('консоль называет версию нужной миграции (v2.4.0), а не версию приложения',
        hintText.includes('под v2.4.0') &&
        !hintText.includes('под v' + CONFIG.APP.VERSION) &&
        hintText.includes('database/migrate-v2.4.sql'),
        hintText || 'подсказки в консоли нет');

    const hintV25 = askedFile('own_delivery_charge');
    ok('в подсказке видно и имя колонки, и файл (сотрудник может пересказать администратору)',
        hintV25.includes('own_delivery_charge') && hintV25.includes('Supabase → SQL Editor'),
        hintV25.slice(0, 80));

    const namedFiles = [...new Set([...dbJs.matchAll(/database\/migrate-v[\d.]+\.sql/g)].map(m => m[0]))];
    ok('подсказка не отправляет к файлу, которого нет в репозитории',
        namedFiles.length >= 2 && namedFiles.every(name => fs.existsSync(path.join(ROOT, name))),
        namedFiles.join(', '));

    // Список колонок в коде и в миграции — один и тот же: иначе новая колонка
    // v2.6 останется без подсказки, а старая уведёт не к тому файлу.
    const v25Entry = dbJs.slice(dbJs.indexOf("'database/migrate-v2.5.sql'"), dbJs.indexOf("'database/migrate-v2.4.sql'"));
    const v25MissingInDb = v25Unique.filter(col => !v25Entry.includes("'" + col + "'"));
    const v24MixedIntoV25 = v24Columns.filter(col => v25Entry.includes("'" + col + "'"));
    ok('список колонок НДС в js/database.js совпадает с миграцией v2.5.0',
        v25MissingInDb.length === 0 && v24MixedIntoV25.length === 0,
        v25MissingInDb.concat(v24MixedIntoV25).join(', '));

    log('--- ИТОГ ---');
    log(failed === 0
        ? '  ВСЁ ВЕРНО: НДС начисляется один раз, своя доставка — внутренний расход объекта'
        : '  не прошло проверок: ' + failed);
}

// main() асинхронная (загружает модули приложения), поэтому отчёт пишем в
// .finally(): иначе process.exit() оборвал бы прогон на середине.
main()
    .catch((error) => {
        log('ОШИБКА ПРОГОНА: ' + (error && error.stack ? error.stack : error));
        failed += 1;
    })
    .finally(() => {
        const outDir = path.join(os.tmpdir(), 'rsk-fin');
        try {
            fs.mkdirSync(outDir, { recursive: true });
            fs.writeFileSync(path.join(outDir, 'vat-check.txt'), report.join('\r\n'), 'utf8');
        } catch { /* нет доступа к %TEMP% — отчёт остаётся в консоли */ }

        process.exit(failed === 0 ? 0 : 1);
    });
