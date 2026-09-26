// =====================================================================
// МОДУЛЬ: СМЕТА — РАСЧЁТЫ И ДОКУМЕНТЫ
// =====================================================================
// Здесь живёт вся «бухгалтерия» сметы: как из позиций получаются суммы и как
// они превращаются в документы (Excel/PDF). Модуль НИЧЕГО не пишет в базу и
// не рисует интерфейс — его можно вызывать откуда угодно (список смет,
// редактор, проверки) и он всегда посчитает одинаково.
//
// ДВЕ ЦЕНЫ — ЭТО ГЛАВНОЕ ПРАВИЛО МОДУЛЯ:
//   «кошторис» (price_client)   — сколько платит заказчик;
//   «наряд»   (price_worker для работ, price_purchase для материалов) —
//     сколько платим мы (рабочим и поставщикам).
//   Поэтому каждая строка документа считается дважды, а разница сумм и есть
//   прибыль по смете (в итогах редактора — «Прибыль»).
//
// ОКРУГЛЕНИЕ МАТЕРИАЛОВ ВВЕРХ. Материалы нельзя купить «10.4 мешка» —
// количество округляется до целого вверх (Math.ceil), как в бумажных сметах
// (см. roundUpQty). Работы считаются по фактическому объёму.
//
// ДАВАЛЬЧЕСКИЕ МАТЕРИАЛЫ (is_customer_supplied) — те, что привозит заказчик:
// в смете они видны (работы ими закрываются), но в суммы не входят ни по
// кошторису, ни по наряду. Иначе мы посчитали бы заказчику то, что он уже
// купил сам.
//
// ЛИМИТИРОВАННЫЕ РАСХОДЫ И ПДВ считаются ПОСЛЕ работ и материалов:
//   подытог = работы + материалы + лимиты;
//   ПДВ = подытог × ставка / 100 (ставка 0 — налога нет).
// Порядок важен: лимит — от работ и материалов, налог — от подытога целиком.
// =====================================================================

import { CONFIG } from '../config.js';
import { log, toast, escapeHtml, roundMoney, renderPdfCanvas } from '../utils.js';
import { getLang } from '../i18n.js';

// =====================================================================
// ЧИСЛА
// =====================================================================

/**
 * Количество материала к закупке: всегда вверх до целого.
 * 10.4 мешка → 11 (купить половину мешка нельзя, а недостача остановит работу).
 */
export function roundUpQty(value) {
    const num = Number(value) || 0;
    if (num <= 0) return 0;
    return Math.ceil(num);
}

/**
 * Сумма лимитированного расхода: процент от работ, от материалов или от обоих.
 * @param {number} percent — ставка лимита, %
 * @param {string} base — 'works' | 'materials' | 'both'
 */
export function calcLimitAmount(percent, base, workSum, matSum) {
    const rate = Number(percent) || 0;
    if (rate <= 0) return 0;

    const works = Number(workSum) || 0;
    const materials = Number(matSum) || 0;

    if (base === 'works') return roundMoney(works * (rate / 100));
    if (base === 'materials') return roundMoney(materials * (rate / 100));
    return roundMoney((works + materials) * (rate / 100));
}

/** Понятное название базы лимита (для документов и подсказок). */
export function limitBaseLabel(base) {
    const found = (CONFIG.ESTIMATE?.LIMIT_BASES || []).find(item => item.value === base);
    return found ? found.label : '';
}

/**
 * База лимита/ПДВ для ДОКУМЕНТА: CONFIG хранит один (русский) набор подписей,
 * а печатать нужно на языке документа — «от работ» или «від робіт».
 */
function baseLabelOf(base) {
    const text = docText().base;
    return text[base] || text.both;
}

// =====================================================================
// РАСЧЁТ ПОЗИЦИИ, РАЗДЕЛА И СМЕТЫ ЦЕЛИКОМ
// =====================================================================

/**
 * Материал позиции → деньги. Давальческий материал в суммы не входит.
 * @returns {{client: number, worker: number, qty: number, skipped: boolean}}
 */
export function calcItemMaterial(material) {
    const qty = roundUpQty(material.quantity);

    if (material.is_customer_supplied) {
        return { client: 0, worker: 0, qty, skipped: true };
    }

    return {
        client: roundMoney(qty * (Number(material.price_client) || 0)),
        worker: roundMoney(qty * (Number(material.price_purchase) || 0)),
        qty,
        skipped: false
    };
}

/**
 * Позиция (работа) → суммы. Материалы считаются по своим количествам,
 * а не по объёму работы: в смете их количество уже приведено к закупке.
 */
export function calcItem(item) {
    const qty = Number(item.quantity) || 0;

    const workWorker = roundMoney(qty * (Number(item.price_worker) || 0));
    const workClient = roundMoney(qty * (Number(item.price_client) || 0));

    let matClient = 0;
    let matWorker = 0;
    let matCount = 0;

    (item.materials || []).forEach(material => {
        const sums = calcItemMaterial(material);
        matClient += sums.client;
        matWorker += sums.worker;
        if (!sums.skipped) matCount += 1;
    });

    return {
        workWorker,
        workClient,
        matClient: roundMoney(matClient),
        matWorker: roundMoney(matWorker),
        clientTotal: roundMoney(workClient + matClient),
        workerTotal: roundMoney(workWorker + matWorker),
        profit: roundMoney(workClient + matClient - workWorker - matWorker),
        matCount
    };
}

/** Раздел сметы → суммы + построчные расчёты (для таблицы и документов). */
export function calcSection(section) {
    const rows = (section.items || []).map(item => ({
        item,
        sums: calcItem(item)
    }));

    const totals = rows.reduce((acc, entry) => ({
        workWorker: roundMoney(acc.workWorker + entry.sums.workWorker),
        workClient: roundMoney(acc.workClient + entry.sums.workClient),
        matClient: roundMoney(acc.matClient + entry.sums.matClient),
        matWorker: roundMoney(acc.matWorker + entry.sums.matWorker)
    }), { workWorker: 0, workClient: 0, matClient: 0, matWorker: 0 });

    return {
        section,
        rows,
        ...totals,
        clientTotal: roundMoney(totals.workClient + totals.matClient),
        workerTotal: roundMoney(totals.workWorker + totals.matWorker)
    };
}

/**
 * Смета целиком → итоги для шапки редактора и документов:
 * работы, материалы, лимиты, подытог, ПДВ, всего — по кошторису и по наряду.
 */
export function calcEstimate(estimate) {
    const sections = (estimate?.sections || []).map(calcSection);

    const sums = sections.reduce((acc, section) => ({
        workClient: roundMoney(acc.workClient + section.workClient),
        workWorker: roundMoney(acc.workWorker + section.workWorker),
        matClient: roundMoney(acc.matClient + section.matClient),
        matWorker: roundMoney(acc.matWorker + section.matWorker)
    }), { workClient: 0, workWorker: 0, matClient: 0, matWorker: 0 });

    const limits = (estimate?.limits || []).map(limit => ({
        limit,
        amount: calcLimitAmount(limit.percent, limit.base, sums.workClient, sums.matClient)
    }));

    const limitsTotal = roundMoney(limits.reduce((acc, entry) => acc + entry.amount, 0));

    const subTotal = roundMoney(sums.workClient + sums.matClient + limitsTotal);
    const vatPercent = Number(estimate?.vat_percent) || 0;
    const vatAmount = vatPercent > 0 ? roundMoney(subTotal * (vatPercent / 100)) : 0;
    const grandTotal = roundMoney(subTotal + vatAmount);

    // «Наряд» — деньги исполнителям и поставщикам. Лимиты и ПДВ в него не
    // входят: это наша себестоимость, а не сумма к оплате заказчиком.
    const naryadTotal = roundMoney(sums.workWorker + sums.matWorker);

    return {
        sections,
        limits,
        limitsTotal,
        workClient: sums.workClient,
        workWorker: sums.workWorker,
        matClient: sums.matClient,
        matWorker: sums.matWorker,
        subTotal,
        vatPercent,
        vatAmount,
        grandTotal,
        naryadTotal,
        profit: roundMoney(grandTotal - naryadTotal)
    };
}

// =====================================================================
// ДОКУМЕНТЫ: МОДЕЛЬ, HTML (PDF) И EXCEL
// =====================================================================
// Модель документа собирается ОДИН раз (buildEstimateDoc) и дальше только
// рисуется: таблицей HTML для PDF (html2canvas + jsPDF) и листом Excel.
// Поэтому все четыре вида документа (кошторис 6 граф, кошторис 9 граф, наряд,
// відомість матеріалів) выглядят одинаково в обоих форматах: расхождение
// возможно только в рисовальщике, но не в цифрах и не в наборе строк.
//
// ЧТО ВЫБИРАЕТ СОТРУДНИК (окно «📥 Експорт документа», js/modules/estimates.js):
//   * вид документа — кошторис / наряд на роботи / відомість матеріалів;
//   * вид кошторису — 6-ти графка (книжна, портрет) или 9-ти (альбомна);
//   * колір шапки — заливка строки заголовків таблицы;
//   * формат — PDF или Excel.
// Списки вариантов лежат в CONFIG.ESTIMATE (DOC_KINDS / DOC_VIEWS / DOC_COLORS)
// — там же их видит разметка, дублировать их здесь нельзя.
//
// ЯЗЫК ФАЙЛА. Подписи документа берутся из DOC_TEXT по языку из «Настроек»
// (getLang()): русский интерфейс — русский файл, украинский — украинский.
// Переводятся только подписи модуля; названия работ, материалов, разделов,
// заказчика и примечания — данные сотрудника, их печатаем как ввели.
//
// ДЕВЯТЬ ГРАФ — ЭТО РАЗБИВКА ЦЕНЫ И ВАРТОСТИ НА РОБОТИ/МАТЕРІАЛИ:
//   № | Найменування | Од. вим. | К-сть | Ціна одиниці (Роботи|Матеріали) |
//   Вартість (Роботи|Матеріали|Всього). Шесть граф — то же самое одной строкой:
//   № | Найменування | Од. | К-сть | Ціна | Сума (материалы позиции — отдельными
//   строками с «•»).
//
// КОЛІР ШАПКИ в Excel требует записи заливки: бесплатный SheetJS (CDN xlsx
// 0.18.5) её молча выбрасывает, поэтому приложение грузит совместимый
// xlsx-js-style (см. index.html → script и README → «Библиотеки с CDN»).
//
// КОШТОРИС ПЕЧАТАЕТ ЦЕНЫ «КОШТОРИС» (price_client), а не «наряд»: в кошторисе
// заказчик видит свою цену. Наряд («Наряд на роботи») — наоборот, цены
// исполнителям (price_worker / price_purchase).
// =====================================================================

const DOC_KINDS = CONFIG.ESTIMATE?.DOC_KINDS || [];
const DOC_VIEWS = CONFIG.ESTIMATE?.DOC_VIEWS || [];
const DOC_COLORS = CONFIG.ESTIMATE?.DOC_COLORS || [];

// =====================================================================
// ЯЗЫК ДОКУМЕНТА (RU / UK)
// =====================================================================
// Документ печатается НЕ как экран: у него нет DOM, по которому ходит словарь
// js/i18n.js, поэтому подписи берутся сразу на языке из «Настроек»
// (getLang()). Русский — исходный (им же подписаны остальные модули), вторая
// колонка — печатная украинская версия. Подписи ВВОДИТ сотрудник — названия
// работ, материалов, разделов, заказчик и примечания — не переводятся: это его
// данные. Списки вариантов окна экспорта (CONFIG.ESTIMATE.DOC_*) остаются
// украинскими: это экран приложения, а не файл.
//
// Обе колонки лежат рядом строка за строкой, поэтому «забыть перевести»
// подпись трудно, а прогон tools/checks/migration-check.mjs проверяет, что
// таблица есть и что язык в неё приходит из i18n.js.
const DOC_TEXT = {
    ru: {
        locale: 'ru-RU',
        title: { koshtorys: 'СМЕТА', naryad: 'НАРЯД НА РАБОТЫ', materials: 'ВЕДОМОСТЬ МАТЕРИАЛОВ' },
        // Имя листа Excel: подписи окна экспорта тут не годятся — они украинские.
        sheet: { koshtorys: 'Смета', naryad: 'Наряд на работы', materials: 'Ведомость материалов' },
        view: { '6': '6-ти графка (книжная)', '9': '9-ти графка (альбомная)' },
        subtitle: { koshtorys: 'Работы и материалы', naryad: 'Работы', materials: 'Перечень материалов' },
        date: 'Дата',
        name: 'Название',
        object: 'Объект',
        customer: 'Заказчик',
        phone: 'тел.',
        columns9: {
            number: '№',
            name: 'Наименование работ, материалов, затрат',
            unit: 'Ед. изм.',
            quantity: 'Кол-во',
            price: 'Цена единицы, грн.',
            cost: 'Стоимость, грн.',
            works: 'Работы',
            materials: 'Материалы',
            total: 'Всего'
        },
        columns6: {
            koshtorys: ['№', 'Наименование', 'Ед.', 'Кол-во', 'Цена', 'Сумма'],
            naryad: ['№', 'Наименование работ', 'Ед.', 'Кол-во', 'Цена (наряд)', 'Сумма'],
            materials: ['№', 'Наименование материала', 'Ед.', 'Кол-во', 'Цена', 'Сумма']
        },
        sectionTotal: 'Всего по разделу:',
        workTotal: 'Итого по работам:',
        materialTotal: 'Итого по материалам:',
        naryadWorkTotal: 'Итого за работы:',
        naryadMaterials: 'Материалы (закупка):',
        purchaseTotal: 'ИТОГО К ЗАКУПКЕ:',
        intermediate: 'Промежуточный итог:',
        vat: 'ПДВ',
        base: { works: 'от работ', materials: 'от материалов', both: 'от работ и материалов' },
        grand: 'ВСЕГО:',
        grandNaryad: 'ВСЕГО ПО НАРЯДУ:',
        notes: 'Примечания:',
        contractor: 'Исполнитель',
        foreman: 'Бригадир / рабочий',
        noMaterials: 'Материалов в смете нет'
    },
    uk: {
        locale: 'uk-UA',
        title: { koshtorys: 'КОШТОРИС', naryad: 'НАРЯД НА РОБОТИ', materials: 'ВІДОМІСТЬ МАТЕРІАЛІВ' },
        sheet: { koshtorys: 'Кошторис', naryad: 'Наряд на роботи', materials: 'Відомість матеріалів' },
        view: { '6': '6-ти графка (книжна)', '9': '9-ти графка (альбомна)' },
        subtitle: { koshtorys: 'Роботи та матеріали', naryad: 'Роботи', materials: 'Перелік матеріалів' },
        date: 'Дата',
        name: 'Назва',
        object: 'Об\'єкт',
        customer: 'Замовник',
        phone: 'тел.',
        columns9: {
            number: '№',
            name: 'Найменування робіт, матеріалів, витрат',
            unit: 'Од. вим.',
            quantity: 'К-сть',
            price: 'Ціна одиниці, грн.',
            cost: 'Вартість, грн.',
            works: 'Роботи',
            materials: 'Матеріали',
            total: 'Всього'
        },
        columns6: {
            koshtorys: ['№', 'Найменування', 'Од.', 'К-сть', 'Ціна', 'Сума'],
            naryad: ['№', 'Найменування робіт', 'Од.', 'К-сть', 'Ціна (наряд)', 'Сума'],
            materials: ['№', 'Найменування матеріалу', 'Од.', 'К-сть', 'Ціна', 'Сума']
        },
        sectionTotal: 'Всього по розділу:',
        workTotal: 'Разом по роботах:',
        materialTotal: 'Разом по матеріалах:',
        naryadWorkTotal: 'Разом за роботами:',
        naryadMaterials: 'Матеріали (закупівля):',
        purchaseTotal: 'ВСЬОГО ДО ЗАКУПІВЛІ:',
        intermediate: 'Проміжний підсумок:',
        vat: 'ПДВ',
        base: { works: 'від робіт', materials: 'від матеріалів', both: 'від робіт і матеріалів' },
        grand: 'ВСЬОГО:',
        grandNaryad: 'ВСЬОГО ЗА НАРЯДОМ:',
        notes: 'Примітки:',
        contractor: 'Виконавець',
        foreman: 'Бригадир / робітник',
        noMaterials: 'Матеріалів у сметі немає'
    }
};

/** Подписи документа на языке, выбранном в «Настройках» этого устройства. */
function docText() {
    return DOC_TEXT[getLang()] || DOC_TEXT.ru;
}

/** Деньги в документе: всегда два знака после запятой («1 500,00»). */
function moneyText(value) {
    return (Number(value) || 0).toLocaleString(docText().locale, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

/** Целое количество: материалы округляются вверх (полмешка не купить). */
function intText(value) {
    return String(Math.round(Number(value) || 0));
}

/**
 * Ячейка документа: текст и оформление. Все рисовальщики читают ТОЛЬКО её —
 * поэтому новое поле (ещё одна колонка документа) не приходится добавлять в
 * двух местах.
 *   style: company | companySmall | title | meta | subtitle | section | header |
 *          cell | material | total | summary | grand | notesTitle | note |
 *          signature | line | gap
 */
function cell(text, options = {}) {
    return {
        text: text === null || text === undefined ? '' : text,
        colspan: Math.max(1, Number(options.colspan) || 1),
        rowspan: Math.max(1, Number(options.rowspan) || 1),
        align: options.align || 'left',
        style: options.style || 'cell',
        money: Boolean(options.money),
        int: Boolean(options.int),
        suffix: options.suffix || ''
    };
}

/** Публичные списки вариантов — их показывает окно экспорта. */
export function getDocKinds() {
    return DOC_KINDS;
}

export function getDocViews() {
    return DOC_VIEWS;
}

export function getDocColors() {
    return DOC_COLORS;
}

/** Имя файла без символов, которые ломают загрузку в Windows. */
export function safeFilePart(text) {
    const cleaned = String(text || '')
        .replace(/[^a-zA-Z0-9а-яА-ЯіїєґІЇЄҐ\s._-]/g, '')
        .trim()
        .replace(/\s+/g, '_')
        .slice(0, 60);

    return cleaned || 'smeta';
}

/**
 * Сводка материалов по всей смете: одинаковые материалы собираются в одну
 * строку. Это то, что нужно снабженцу — «сколько чего покупать», а не
 * «в какой работе сколько лежит».
 * Давальческие материалы попадают в список, но в сумму не входят.
 */
export function aggregateMaterials(estimate) {
    const map = new Map();

    (estimate?.sections || []).forEach(section => {
        (section.items || []).forEach(item => {
            (item.materials || []).forEach(material => {
                const qty = roundUpQty(material.quantity);
                if (qty <= 0) return;

                const key = [
                    String(material.name || '').trim().toLowerCase(),
                    material.unit || '',
                    Number(material.price_purchase) || 0,
                    material.is_customer_supplied ? 'daval' : 'own'
                ].join('|');

                const entry = map.get(key) || {
                    name: material.name,
                    unit: material.unit || 'шт',
                    qty: 0,
                    pricePurchase: Number(material.price_purchase) || 0,
                    isCustomerSupplied: Boolean(material.is_customer_supplied)
                };

                entry.qty += qty;
                map.set(key, entry);
            });
        });
    });

    return [...map.values()].map(entry => ({
        ...entry,
        sum: entry.isCustomerSupplied ? 0 : roundMoney(entry.qty * entry.pricePurchase)
    }));
}


/**
 * Приводит настройки документа к общему виду.
 * Принимает и старый код строкой ('koshtorys6', 'koshtorys9', 'naryad',
 * 'materials' — так документ заказывали до v2.11.0), и объект из окна экспорта
 * ({ kind, view, color }): старые вызовы ломать ради нового окна незачем.
 */
export function normalizeDocOptions(options) {
    if (typeof options === 'string') {
        const legacy = options;
        if (legacy === 'koshtorys6') return normalizeDocOptions({ kind: 'koshtorys', view: '6' });
        if (legacy === 'koshtorys9') return normalizeDocOptions({ kind: 'koshtorys', view: '9' });
        if (legacy === 'materials') return normalizeDocOptions({ kind: 'materials' });
        return normalizeDocOptions({ kind: 'naryad' });
    }

    const source = options || {};
    const kindInfo = DOC_KINDS.find(item => item.value === source.kind) || DOC_KINDS[0] || {
        value: 'koshtorys', label: 'Кошторис', view: true
    };
    const kind = kindInfo.value;

    // Вид кошторису спрашивают только у кошториса: у наряда и ведомости таблица
    // всего одна (6 граф), кнопки «6/9» в окне для них не показываются.
    const view = kindInfo.view && source.view === '9' ? '9' : '6';
    const viewInfo = DOC_VIEWS.find(item => item.value === view);

    const color = DOC_COLORS.some(item => item.value === source.color) ? source.color : 'none';
    const palette = DOC_COLORS.find(item => item.value === color)
        || { value: 'none', label: 'Без кольору', bg: null, text: '111827' };

    const wide = kind === 'koshtorys' && view === '9';

    return {
        kind,
        view,
        color,
        palette,
        wide,
        columns: wide ? 9 : 6,
        label: kindInfo.label,
        viewLabel: viewInfo ? viewInfo.label : '',
        // Имя листа Excel — на языке ДОКУМЕНТА: подписи из CONFIG.ESTIMATE
        // описывают окно экспорта (экран приложения), а лист видно в самом файле.
        sheetName: [docText().sheet[kind] || kindInfo.label,
            kindInfo.view ? docText().view[view] : ''].filter(Boolean).join(' '),
        // Подпись для файла: «Koshtorys-9graph_00001_2026_Покрівля.xlsx».
        fileBase: kind === 'koshtorys'
            ? `Koshtorys-${view}graph`
            : (kind === 'materials' ? 'Vidomist-materialiv' : 'Naryad')
    };
}

/** Заказчик: в редакторе это client_id, в документах — уже готовое имя. */
function clientNameOf(estimate) {
    return estimate?.client_name || estimate?.client?.name || '';
}

function subtitleOf(doc) {
    const text = docText().subtitle;
    return text[doc.kind] || text.koshtorys;
}

function titleOf(doc) {
    const text = docText().title;
    return text[doc.kind] || text.koshtorys;
}

/**
 * Шапка документа: реквизиты, название, номер, назва/об'єкт/замовник и
 * подзаголовок. Одна и та же шапка у кошториса, наряда и ведомости.
 */
function titleRows(estimate, company, doc) {
    const text = docText();
    const totals = calcEstimate(estimate);
    const source = company || {};
    const contacts = [
        source.address,
        source.phone ? `${text.phone} ${source.phone}` : '',
        source.email,
        source.website
    ].filter(Boolean).join(' · ');

    const total = doc.columns;
    const rows = [];

    if (source.company_name) {
        rows.push(row('company', [cell(source.company_name, { colspan: total, align: 'right', style: 'company' })]));
    }
    if (contacts) {
        rows.push(row('companySmall', [cell(contacts, { colspan: total, align: 'right', style: 'companySmall' })]));
    }

    const titleWidth = Math.max(1, Math.ceil(total / 2));
    rows.push(row('title', [
        cell(titleOf(doc), { colspan: titleWidth, style: 'title' }),
        cell(`${text.date}: ${new Date().toLocaleDateString(text.locale)}`,
            { colspan: Math.max(1, total - titleWidth), align: 'right', style: 'meta' })
    ]));

    rows.push(row('number', [cell(`№ ${estimate?.number || '—'}`, { colspan: total, style: 'meta' })]));
    rows.push(row('gap', [cell('', { colspan: total, style: 'gap' })]));
    rows.push(row('name', [cell(`${text.name}: ${estimate?.title || '—'}`, { colspan: total, style: 'meta' })]));
    rows.push(row('object', [cell(`${text.object}: ${estimate?.object_name || '—'}`, { colspan: total, style: 'meta' })]));
    rows.push(row('client', [cell(`${text.customer}: ${clientNameOf(estimate) || '—'}`, { colspan: total, style: 'meta' })]));
    rows.push(row('subtitle', [cell(subtitleOf(doc), { colspan: total, style: 'subtitle' })]));

    return { rows, totals };
}

/**
 * Кошторис, 9 граф: цена и вартість разложены на роботи/матеріали — то, что
 * печатают в альбомном виде для согласования. Заголовок двухъярусный, поэтому
 * он повторяется в каждом разделе отдельным блоком (см. buildGrid).
 */
export function buildKoshtorys9Rows(estimate, totals) {
    const rows = [];
    const text = docText();
    const columns = text.columns9;

    const headerBlock = () => [
        row('header', [
            cell(columns.number, { rowspan: 2, align: 'center', style: 'header' }),
            cell(columns.name, { rowspan: 2, style: 'header' }),
            cell(columns.unit, { rowspan: 2, align: 'center', style: 'header' }),
            cell(columns.quantity, { rowspan: 2, align: 'center', style: 'header' }),
            cell(columns.price, { colspan: 2, align: 'center', style: 'header' }),
            cell(columns.cost, { colspan: 3, align: 'center', style: 'header' })
        ]),
        row('header', [
            cell(columns.works, { align: 'center', style: 'header' }),
            cell(columns.materials, { align: 'center', style: 'header' }),
            cell(columns.works, { align: 'center', style: 'header' }),
            cell(columns.materials, { align: 'center', style: 'header' }),
            cell(columns.total, { align: 'center', style: 'header' })
        ])
    ];

    totals.sections.forEach((section, index) => {
        rows.push(row('section', [cell(`${index + 1}. ${section.section.name || '—'}`, { colspan: 9, style: 'section' })]));
        rows.push(...headerBlock());

        let number = 0;

        section.rows.forEach(({ item, sums }) => {
            number += 1;

            rows.push(row('item', [
                cell(number, { align: 'center' }),
                cell(item.name || '—'),
                cell(item.unit || '', { align: 'center' }),
                cell(Number(item.quantity) || 0, { align: 'center', money: true }),
                cell(Number(item.price_client) || 0, { align: 'right', money: true }),
                cell('', { align: 'right' }),
                cell(sums.workClient, { align: 'right', money: true }),
                cell('', { align: 'right' }),
                cell(sums.clientTotal, { align: 'right', money: true })
            ]));

            (item.materials || []).forEach(material => {
                const calc = calcItemMaterial(material);

                rows.push(row('material', [
                    cell('', { align: 'center' }),
                    cell(`• ${material.name || ''}`, { style: 'material' }),
                    cell(material.unit || '', { align: 'center' }),
                    cell(calc.qty, { align: 'center', int: true }),
                    cell('', { align: 'right' }),
                    calc.skipped
                        ? cell(text.customer, { align: 'center', style: 'material' })
                        : cell(Number(material.price_client) || 0, { align: 'right', money: true }),
                    cell('', { align: 'right' }),
                    calc.skipped ? cell('—', { align: 'center' }) : cell(calc.client, { align: 'right', money: true }),
                    calc.skipped ? cell('—', { align: 'center' }) : cell(calc.client, { align: 'right', money: true })
                ]));
            });
        });

        rows.push(row('sectionTotal', [
            cell(text.sectionTotal, { colspan: 5, align: 'right', style: 'total' }),
            cell('', { align: 'right', style: 'total' }),
            cell(section.workClient, { align: 'right', style: 'total', money: true }),
            cell(section.matClient, { align: 'right', style: 'total', money: true }),
            cell(roundMoney(section.workClient + section.matClient), { align: 'right', style: 'total', money: true })
        ]));
    });

    return rows;
}

/**
 * Наряд на роботи: только работы по нарядным ценам и материалы по закупке —
 * документ для бригады и снабжения, а не для заказчика.
 */
export function buildNaryadRows(estimate, totals) {
    const rows = [];
    const text = docText();

    totals.sections.forEach((section, index) => {
        rows.push(row('section', [cell(`${index + 1}. ${section.section.name || '—'}`, { colspan: 6, style: 'section' })]));
        rows.push(headerRow6('naryad'));

        let number = 0;

        section.rows.forEach(({ item, sums }) => {
            number += 1;

            rows.push(row('item', [
                cell(number, { align: 'center' }),
                cell(item.name || '—'),
                cell(item.unit || '', { align: 'center' }),
                cell(Number(item.quantity) || 0, { align: 'center', money: true }),
                cell(Number(item.price_worker) || 0, { align: 'right', money: true }),
                cell(sums.workWorker, { align: 'right', money: true })
            ]));

            (item.materials || []).forEach(material => {
                const calc = calcItemMaterial(material);

                rows.push(row('material', [
                    cell('', { align: 'center' }),
                    cell(`• ${material.name || ''}`, { style: 'material' }),
                    cell(material.unit || '', { align: 'center' }),
                    cell(calc.qty, { align: 'center', int: true }),
                    calc.skipped
                        ? cell(text.customer, { align: 'center', style: 'material' })
                        : cell(Number(material.price_purchase) || 0, { align: 'right', money: true }),
                    calc.skipped ? cell('—', { align: 'center' }) : cell(calc.worker, { align: 'right', money: true })
                ]));
            });
        });

        rows.push(row('sectionTotal', [
            cell(text.sectionTotal, { colspan: 4, align: 'right', style: 'total' }),
            cell('', { align: 'right', style: 'total' }),
            cell(roundMoney(section.workerTotal), { align: 'right', style: 'total', money: true })
        ]));
    });

    return rows;
}

/**
 * Відомість матеріалів: что и сколько закупать по всей смете. Одинаковые
 * материалы из разных работ собираются в одну строку (aggregateMaterials),
 * давальческие видны, но в сумму не входят.
 */
export function buildMaterialsRows(estimate) {
    const rows = [headerRow6('materials')];
    const text = docText();
    let number = 0;

    aggregateMaterials(estimate).forEach(material => {
        number += 1;

        rows.push(row('item', [
            cell(number, { align: 'center' }),
            cell(material.name || '—'),
            cell(material.unit || '', { align: 'center' }),
            cell(material.qty, { align: 'center', int: true }),
            material.isCustomerSupplied
                ? cell(text.customer, { align: 'center', style: 'material' })
                : cell(material.pricePurchase, { align: 'right', money: true }),
            material.isCustomerSupplied
                ? cell('—', { align: 'center' })
                : cell(material.sum, { align: 'right', money: true })
        ]));
    });

    if (number === 0) {
        rows.push(row('item', [cell(text.noMaterials, { colspan: 6, align: 'center', style: 'material' })]));
    }

    return rows;
}

// =====================================================================
// ИТОГИ, ПРИМЕЧАНИЯ, ПОДПИСИ
// =====================================================================

/**
 * Строки итогов документа: работы, материалы, лимиты, подытог, ПДВ.
 * Подписи — на языке документа (docText()): это печатный файл, а не экран
 * приложения, поэтому словарь i18n сюда не достаёт.
 */
function summaryRows(estimate, totals, doc) {
    const text = docText();
    const total = doc.columns;
    const labelSpan = total - 1;
    const rows = [];

    const pairs = doc.kind === 'naryad'
        ? [
            [text.naryadWorkTotal, roundMoney(totals.workWorker), true],
            [text.naryadMaterials, roundMoney(totals.matWorker), false]
        ]
        : (doc.kind === 'materials'
            ? [[text.purchaseTotal, roundMoney(totals.matWorker), true]]
            : [
                [text.workTotal, roundMoney(totals.workClient), true],
                [text.materialTotal, roundMoney(totals.matClient), false]
            ]);

    pairs.forEach(([label, value, suffix]) => {
        rows.push(row('summary', [
            cell(label, { colspan: labelSpan, align: 'right', style: 'summary' }),
            cell(value, { align: 'right', style: 'summary', money: true, suffix: suffix ? ' грн' : '' })
        ]));
    });

    if (doc.kind === 'koshtorys') {
        (totals.limits || []).forEach(({ limit, amount }) => {
            if (!(amount > 0)) return;
            rows.push(row('summary', [
                cell(`${limit.name} (${limit.percent}% ${baseLabelOf(limit.base)}):`,
                    { colspan: labelSpan, align: 'right', style: 'summary' }),
                cell(amount, { align: 'right', style: 'summary', money: true, suffix: ' грн' })
            ]));
        });

        if (totals.limitsTotal > 0) {
            rows.push(row('summary', [
                cell(text.intermediate, { colspan: labelSpan, align: 'right', style: 'summary' }),
                cell(totals.subTotal, { align: 'right', style: 'summary', money: true, suffix: ' грн' })
            ]));
        }

        if (totals.vatAmount > 0) {
            rows.push(row('summary', [
                cell(`${text.vat} ${totals.vatPercent}% (${baseLabelOf(estimate?.vat_base || 'both')}):`,
                    { colspan: labelSpan, align: 'right', style: 'summary' }),
                cell(totals.vatAmount, { align: 'right', style: 'summary', money: true, suffix: ' грн' })
            ]));
        }
    }

    rows.push(row('gap', [cell('', { colspan: total, style: 'gap' })]));

    const grandLabel = doc.kind === 'naryad' ? text.grandNaryad : text.grand;
    const grandValue = doc.kind === 'naryad' ? totals.naryadTotal
        : (doc.kind === 'materials' ? totals.matWorker : totals.grandTotal);

    rows.push(row('grand', [
        cell(grandLabel, { colspan: labelSpan, align: 'right', style: 'grand' }),
        cell(grandValue, { align: 'right', style: 'grand', money: true, suffix: ' грн' })
    ]));

    return rows;
}

/** Примечания сметы: печатаются нумерованным списком под итогами. */
function notesRows(estimate, doc) {
    const notes = String(estimate?.notes || '').trim();
    if (!notes) return [];

    const total = doc.columns;
    const lines = notes.split('\n').map(line => line.trim()).filter(Boolean);

    return [
        row('notesTitle', [cell(docText().notes, { colspan: total, style: 'notesTitle' })]),
        ...lines.map((line, index) => row('note', [
            cell(`${index + 1}. ${line}`, { colspan: total, style: 'note' })
        ]))
    ];
}

/** Подписи: исполнитель и заказчик (у наряда — бригадир). */
function signatureRows(doc) {
    const text = docText();
    const total = doc.columns;
    const half = Math.ceil(total / 2);

    const right = doc.kind === 'naryad' ? text.foreman : text.customer;

    return [
        row('gap', [cell('', { colspan: total, style: 'gap' })]),
        row('signature', [
            cell(text.contractor, { colspan: half, style: 'signature' }),
            cell(right, { colspan: total - half, style: 'signature' })
        ]),
        row('line', [
            cell('__________________', { colspan: half, style: 'line' }),
            cell('__________________', { colspan: total - half, style: 'line' })
        ])
    ];
}

// =====================================================================
// СБОРКА ДОКУМЕНТА
// =====================================================================

/**
 * Документ целиком: строки (шапка, таблица, итоги, подписи) и сетка ячеек.
 * Модель читают оба рисовальщика — HTML для PDF и Excel, — поэтому строки и
 * цифры в файлах совпадают by construction.
 */
export function buildEstimateDoc(estimate, company, options) {
    const doc = normalizeDocOptions(options);
    const { rows: headRows, totals } = titleRows(estimate, company, doc);

    const tableRows = doc.kind === 'naryad'
        ? buildNaryadRows(estimate, totals)
        : (doc.kind === 'materials'
            ? buildMaterialsRows(estimate)
            : (doc.wide ? buildKoshtorys9Rows(estimate, totals) : buildKoshtorys6Rows(estimate, totals)));

    const rows = [
        ...headRows,
        ...tableRows,
        ...summaryRows(estimate, totals, doc),
        ...notesRows(estimate, doc),
        ...signatureRows(doc)
    ];

    const { grid, merges } = buildGrid(rows, doc.columns);

    return { doc, totals, rows, grid, merges, columns: doc.columns };
}

/**
 * Раскладывает строки в прямоугольную сетку: адреса ячеек и объединения.
 * Нужна из-за rowspan в шапке 9-ти графки: Excel объявляет такие ячейки через
 * `!merges`, HTML — атрибутами, а без сетки пришлось бы считать это дважды.
 * В покрытых ячейках стоит null — рисовальщик их пропускает.
 */
export function buildGrid(rows, total) {
    const grid = [];
    const merges = [];
    const occupied = [];

    const mark = (r, c, value) => {
        if (!grid[r]) grid[r] = [];
        if (!occupied[r]) occupied[r] = [];
        grid[r][c] = value;
        occupied[r][c] = true;
    };
    const isOccupied = (r, c) => Boolean(occupied[r] && occupied[r][c]);

    rows.forEach((line, r) => {
        let column = 0;

        line.cells.forEach(entry => {
            while (isOccupied(r, column)) column += 1;

            for (let dr = 0; dr < entry.rowspan; dr += 1) {
                for (let dc = 0; dc < entry.colspan; dc += 1) {
                    const origin = dr === 0 && dc === 0;
                    mark(r + dr, column + dc, origin ? { cell: entry } : null);
                }
            }

            if (entry.rowspan > 1 || entry.colspan > 1) {
                merges.push({
                    s: { r, c: column },
                    e: { r: r + entry.rowspan - 1, c: column + entry.colspan - 1 }
                });
            }

            column += entry.colspan;
        });
    });

    for (let r = 0; r < rows.length; r += 1) {
        if (!grid[r]) grid[r] = [];
        for (let c = 0; c < total; c += 1) {
            if (grid[r][c] === undefined) grid[r][c] = null;
        }
    }

    return { grid, merges };
}

/** Имя файла документа: «Koshtorys-9graph_00002_2026_Покрівля.xlsx». */
export function docFileName(estimate, doc, extension) {
    const number = String(estimate?.number || '').replace(/\//g, '_');
    const title = safeFilePart(estimate?.title || estimate?.object_name || '');
    return `${doc.fileBase}_${number}_${title}.${extension}`;
}

// =====================================================================
// HTML ДЛЯ PDF
// =====================================================================
// Способ тот же, что и в остальном приложении (js/modules/files.js): готовую
// разметку снимает html2canvas, а страницы раскладывает jsPDF. Стили заданы
// АТРИБУТАМИ, а не классами: документ живёт в отсоединённом блоке, имена вида
// «company» или «section» столкнулись бы с общими правилами приложения (и
// прогон frontend-check справедливо требует, чтобы каждый класс из модулей был
// объявлен в стилях). Атрибуты style политика CSP разрешает
// (style-src 'unsafe-inline') — так же, как в существующей генерации PDF.

const DOC_BORDER = '1px solid #9ca3af';

/** Оформление ячейки в HTML: палитра нужна только строке заголовков. */
function htmlCellStyle(entry, palette) {
    const align = entry.align === 'right' ? 'right' : (entry.align === 'center' ? 'center' : 'left');
    // vertical-align:middle — текст стоит по центру рамки. Без него высокая
    // ячейка (объединённая шапка 9-ти графки, строка «Всього по розділу»)
    // прижимала подпись к верхней грани и на печати это выглядело криво.
    // В PDF правило работает только вместе с renderPdfCanvas (js/utils.js):
    // html2canvas рисует текст по разметке браузера, но свою «базовую линию»
    // считает пробником, которому preflight Tailwind ломает поведение.
    const box = `border:${DOC_BORDER};padding:3px 6px;text-align:${align};vertical-align:middle`;

    switch (entry.style) {
        case 'company': return 'font-size:15px;font-weight:700;text-align:right;padding:0 2px';
        case 'companySmall': return 'font-size:10px;color:#374151;text-align:right;padding:0 2px 8px';
        case 'title': return 'font-size:20px;font-weight:700;padding:10px 2px 0;vertical-align:bottom';
        case 'meta': return `font-size:11px;color:#374151;padding:1px 2px;text-align:${align};vertical-align:bottom`;
        case 'subtitle': return 'font-size:13px;font-weight:700;padding:14px 2px 6px';
        case 'section': return 'font-size:11px;font-weight:700;padding:10px 2px 3px';
        case 'header': {
            const background = palette.bg ? `#${palette.bg}` : '#f3f4f6';
            const color = palette.bg ? `#${palette.text}` : '#111827';
            return `${box};font-weight:700;text-align:center;background:${background};color:${color}`;
        }
        case 'material': return `${box};font-size:10px;font-style:italic;color:#4b5563`;
        case 'total': return `${box};font-weight:700`;
        case 'summary': return `padding:2px 6px;font-weight:700;text-align:${align}`;
        case 'grand': return `padding:8px 6px 2px;font-weight:700;font-size:14px;text-align:${align}`;
        case 'notesTitle': return 'font-size:10px;font-weight:700;padding:12px 2px 2px';
        case 'note': return 'font-size:10px;color:#374151;padding:1px 2px';
        case 'signature': return 'font-size:11px;padding:36px 2px 2px';
        case 'line': return 'border-bottom:1px solid #111827;padding:0 2px 1px;height:1px';
        case 'gap': return 'height:10px;line-height:10px;font-size:10px;padding:0';
        default: return box;
    }
}

/** Текст ячейки для HTML: деньги — с двумя знаками, подпись наряда — «• имя». */
function htmlCellText(entry) {
    const value = entry.cell.text;
    const base = typeof value === 'number'
        ? (entry.cell.int ? intText(value) : moneyText(value))
        : String(value);
    return escapeHtml(base + entry.cell.suffix);
}

/**
 * Разметка документа: из неё собирается PDF (и она же — «бумажный» вид
 * документа). Пиксельная ширина выставляется вызывающим кодом: 9-ти графка
 * шире, поэтому печатается альбомной страницей.
 */
export function buildDocHtml(model) {
    const { doc, grid } = model;
    const palette = doc.palette;

    const body = grid.map(line => {
        const cells = line.map(entry => {
            if (!entry) return '';

            const span = (entry.cell.rowspan > 1 ? ` rowspan="${entry.cell.rowspan}"` : '')
                + (entry.cell.colspan > 1 ? ` colspan="${entry.cell.colspan}"` : '');

            const text = entry.cell.style === 'line' ? '' : htmlCellText(entry);
            return `<td${span} style="${htmlCellStyle(entry.cell, palette)}">${text}</td>`;
        }).join('');

        return `<tr>${cells}</tr>`;
    }).join('');

    return `
        <div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#111827">
            <table style="width:100%;border-collapse:collapse;font-size:11px">
                <tbody>${body}</tbody>
            </table>
        </div>
    `;
}

// =====================================================================
// EXCEL
// =====================================================================
// Числа записываются числами (aoa_to_sheet + формат ячеек): в Excel по ним
// считают формулы, а текст «12 345,60 грн» не посчитать. Подписи « грн» из
// модели в Excel не попадают — их роль играет денежный формат колонки.
//
// ЗАЛИВКУ ШАПКИ пишет xlsx-js-style (совместимая замена SheetJS CE): прежняя
// библиотека (xlsx 0.18.5) `cell.s` молча выбрасывала, и «колір шапки» работал
// бы только в PDF. Библиотеки одного API, менять вызовы не потребовалось.

const EXCEL_BORDER = {
    top: { style: 'thin', color: { rgb: '999999' } },
    left: { style: 'thin', color: { rgb: '999999' } },
    bottom: { style: 'thin', color: { rgb: '999999' } },
    right: { style: 'thin', color: { rgb: '999999' } }
};

const EXCEL_MONEY_FORMAT = '#,##0.00';
const EXCEL_INT_FORMAT = '0';

/**
 * Оформление ячейки Excel по стилю из модели документа.
 *
 * Ключи стиля — КАК В XML, а не как в javascript-обёртках: размер шрифта `sz`
 * (в exceljs он `size`) и заливка `{ patternType: 'solid', fgColor }`. Это
 * правило xlsx-js-style: неизвестный ключ молча теряется (так `size` не попал
 * бы в файл, а шапка осталась бы 11-м кеглем).
 */
function excelStyle(entry, palette) {
    const font = { name: 'Calibri', sz: 10, color: { rgb: '111827' } };
    const align = { horizontal: entry.align, vertical: 'middle' };

    switch (entry.style) {
        case 'company': return { font: { ...font, sz: 14, bold: true }, alignment: { horizontal: 'right' } };
        case 'companySmall': return { font: { ...font, color: { rgb: '374151' } }, alignment: { horizontal: 'right' } };
        case 'title': return { font: { ...font, sz: 18, bold: true }, alignment: { horizontal: 'left', vertical: 'bottom' } };
        case 'meta': return { font: { ...font, sz: 11, color: { rgb: '374151' } }, alignment: align };
        case 'subtitle': return { font: { ...font, sz: 13, bold: true } };
        case 'section': return { font: { ...font, sz: 11, bold: true } };
        case 'header': {
            const style = {
                font: {
                    name: 'Calibri',
                    sz: 10,
                    bold: true,
                    color: { rgb: palette.bg ? palette.text : '111827' }
                },
                // wrapText библиотека не пишет: длинные подписи шапки укладываются
                // в ширину колонок (40 знаков) при высоте строки 26pt — см. !rows.
                alignment: { horizontal: 'center', vertical: 'middle' },
                border: EXCEL_BORDER
            };
            if (palette.bg) style.fill = { patternType: 'solid', fgColor: { rgb: palette.bg } };
            return style;
        }
        case 'material': return {
            font: { ...font, sz: 9, italic: true, color: { rgb: '4B5563' } },
            alignment: align,
            border: EXCEL_BORDER
        };
        case 'total': return { font: { ...font, bold: true }, alignment: align, border: EXCEL_BORDER };
        case 'summary': return { font: { ...font, bold: true }, alignment: align };
        case 'grand': return { font: { ...font, sz: 14, bold: true }, alignment: align };
        case 'notesTitle': return { font: { ...font, bold: true } };
        case 'note': return { font: { ...font, sz: 9, color: { rgb: '374151' } } };
        case 'signature': return { font: { ...font } };
        case 'line': return { font: { ...font } };
        case 'gap': return null;
        default: return { font, alignment: align, border: EXCEL_BORDER };
    }
}

/** Ширина колонок листа: наименование — широкое, числа — узкие. */
function excelWidths(doc) {
    const widths = doc.wide
        ? [6, 40, 10, 12, 18, 18, 18, 18, 18]
        : [6, 45, 10, 12, 18, 18];
    return widths.map(wch => ({ wch }));
}

/** Имя листа Excel: 31 символ без запрещённых знаков. */
function excelSheetName(doc) {
    // sheetName собирается на языке документа (см. normalizeDocOptions): подписи
    // CONFIG.ESTIMATE описывают окно экспорта и всегда украинские.
    const label = doc.sheetName || doc.label;
    return String(label || 'Документ').replace(/[\\/?*[\]:]/g, '').slice(0, 31);
}

/**
 * Выгружает документ сметы в .xlsx.
 * @returns {boolean} — получилось ли собрать файл
 */
export function exportEstimateExcel(estimate, company, options) {
    if (typeof XLSX === 'undefined') {
        toast('Библиотека XLSX не загружена', 'error');
        return false;
    }

    const model = buildEstimateDoc(estimate, company, options);
    const { doc, grid, merges } = model;

    // ОБЪЕДИНЁННЫЕ ЯЧЕЙКИ. Excel рисует рамку объединения по КРАЯМ диапазона,
    // то есть по границам его крайних ячеек. Поэтому покрытые ячейки получают
    // копию ячейки-источника (с пустым текстом): тогда и разметка, и стиль
    // считаются одним и тем же кодом, и у объединения не «теряются» нижняя и
    // правая грани — именно так выглядела неполная рамка таблицы в 9-ти
    // графке (шапка с rowspan и строка «Всього по розділу:»).
    const cells = grid.map(line => line.map(entry => (entry ? { cell: entry.cell } : null)));

    merges.forEach(({ s, e }) => {
        const origin = cells[s.r] && cells[s.r][s.c];
        if (!origin) return;

        for (let r = s.r; r <= e.r; r += 1) {
            cells[r] = cells[r] || [];
            for (let c = s.c; c <= e.c; c += 1) {
                if (r === s.r && c === s.c) continue;
                cells[r][c] = { cell: { ...origin.cell, text: '', money: false, int: false } };
            }
        }
    });

    const aoa = cells.map(line => line.map(entry => {
        if (!entry) return '';
        const value = entry.cell.text;
        if (entry.cell.money || entry.cell.int) return Number(value) || 0;
        return value;
    }));

    const sheet = XLSX.utils.aoa_to_sheet(aoa);
    sheet['!merges'] = merges;
    sheet['!cols'] = excelWidths(doc);

    // Оформление: заливка шапки (колір шапки), жирные итоги, форматы чисел.
    const heights = [];
    cells.forEach((line, r) => {
        const kind = model.rows[r] ? model.rows[r].kind : '';
        if (kind === 'header') heights[r] = { hpt: 26 };
        if (kind === 'gap') heights[r] = { hpt: 8 };

        line.forEach((entry, c) => {
            if (!entry) return;

            const style = excelStyle(entry.cell, doc.palette);
            if (!style) return;

            const address = XLSX.utils.encode_cell({ r, c });
            const target = sheet[address] || (sheet[address] = { t: 's', v: '' });
            target.s = style;

            if (entry.cell.money) target.z = EXCEL_MONEY_FORMAT;
            if (entry.cell.int) target.z = EXCEL_INT_FORMAT;
        });
    });
    sheet['!rows'] = heights;

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, excelSheetName(doc));
    XLSX.writeFile(workbook, docFileName(estimate, doc, 'xlsx'), { cellStyles: true });

    log.info(`Смета ${estimate?.number}: выгружен документ «${doc.label}${doc.viewLabel ? ' ' + doc.viewLabel : ''}» в Excel`);
    return true;
}

// =====================================================================
// PDF
// =====================================================================
// Разметку (buildDocHtml) снимает html2canvas, страницы раскладывает jsPDF —
// тем же способом, что уже делается для PDF сметы объекта и графика Ганта.
// Ориентация страницы зависит от вида документа: 9-ти графка альбомная.

const DOC_PAGE_WIDTH = { 6: 1000, 9: 1500 };

/**
 * Скачивает документ сметы в PDF.
 * @returns {Promise<boolean>} — получилось ли собрать файл
 */
export async function exportEstimatePdf(estimate, company, options) {
    if (typeof html2canvas === 'undefined' || !window.jspdf?.jsPDF) {
        toast('Библиотеки html2canvas или jsPDF не загружены', 'error');
        return false;
    }

    const model = buildEstimateDoc(estimate, company, options);
    const { doc } = model;
    const width = DOC_PAGE_WIDTH[doc.columns] || DOC_PAGE_WIDTH[6];

    const wrapper = document.createElement('div');
    wrapper.style.position = 'fixed';
    wrapper.style.left = '-9999px';
    wrapper.style.top = '0';
    wrapper.style.width = width + 'px';
    wrapper.style.padding = '30px';
    wrapper.style.background = '#ffffff';
    wrapper.innerHTML = buildDocHtml(model);

    document.body.appendChild(wrapper);

    try {
        // Ждём кадр отрисовки: html2canvas снимает уже готовый DOM.
        await new Promise(resolve => setTimeout(resolve, 400));

        // renderPdfCanvas — html2canvas с обходом ошибки измерения шрифта: без
        // него текст печатался на строку ниже (подпись «прилипала» к нижней
        // рамке ячейки) — см. js/utils.js.
        const canvas = await renderPdfCanvas(wrapper, {
            scale: 2,
            useCORS: true,
            backgroundColor: '#ffffff',
            logging: false,
            windowWidth: width
        });

        const { jsPDF } = window.jspdf;
        const pdf = new jsPDF({
            orientation: doc.wide ? 'landscape' : 'portrait',
            unit: 'mm',
            format: 'a4'
        });

        const pageWidth = pdf.internal.pageSize.getWidth();
        const pageHeight = pdf.internal.pageSize.getHeight();
        const imgWidth = pageWidth - 20;
        const imgHeight = (canvas.height * imgWidth) / canvas.width;
        const imgData = canvas.toDataURL('image/png');

        let heightLeft = imgHeight;
        let position = 10;

        pdf.addImage(imgData, 'PNG', 10, position, imgWidth, imgHeight);
        heightLeft -= (pageHeight - 20);

        while (heightLeft > 0) {
            position = heightLeft - imgHeight + 10;
            pdf.addPage();
            pdf.addImage(imgData, 'PNG', 10, position, imgWidth, imgHeight);
            heightLeft -= (pageHeight - 20);
        }

        pdf.save(docFileName(estimate, doc, 'pdf'));
        log.info(`Смета ${estimate?.number}: выгружен документ «${doc.label}${doc.viewLabel ? ' ' + doc.viewLabel : ''}» в PDF`);
        return true;

    } catch (error) {
        log.error('Ошибка генерации PDF сметы:', error);
        toast('Ошибка генерации PDF: ' + error.message, 'error');
        return false;

    } finally {
        wrapper.remove();
    }
}





// =====================================================================
// ТАБЛИЦЫ ДОКУМЕНТОВ
// =====================================================================

/** Строка документа: вид (для отступов и оформления) + ячейки. */
function row(kind, cells) {
    return { kind, cells };
}

/** Заголовки 6 граф — как в бумажной смете (подписи — на языке документа). */
function header6(kind) {
    const columns = docText().columns6;
    return columns[kind] || columns.koshtorys;
}

function headerRow6(kind) {
    return row('header', header6(kind).map((text, index) => cell(text, {
        style: 'header',
        align: index === 1 ? 'left' : (index === 0 || index === 2 ? 'center' : 'right')
    })));
}

/**
 * Кошторис, 6 граф. Материалы позиции идут отдельными строками с «•»: так
 * видно, из чего сложилась сумма, и таблица остаётся книжной (портрет А4).
 */
export function buildKoshtorys6Rows(estimate, totals) {
    const rows = [];
    const text = docText();

    totals.sections.forEach((section, index) => {
        rows.push(row('section', [cell(`${index + 1}. ${section.section.name || '—'}`, { colspan: 6, style: 'section' })]));
        rows.push(headerRow6('koshtorys'));

        // Итог раздела берём из расчёта (calcSection): складывать строки вручную
        // здесь нельзя — материалы позиции уже входят в сумму позиции, и «плюс
        // материал отдельной строкой» посчитал бы их дважды.
        const sectionTotal = roundMoney(section.workClient + section.matClient);

        let number = 0;

        section.rows.forEach(({ item, sums }) => {
            number += 1;

            rows.push(row('item', [
                cell(number, { align: 'center' }),
                cell(item.name || '—'),
                cell(item.unit || '', { align: 'center' }),
                cell(Number(item.quantity) || 0, { align: 'center', money: true }),
                cell(Number(item.price_client) || 0, { align: 'right', money: true }),
                cell(sums.clientTotal, { align: 'right', money: true })
            ]));

            (item.materials || []).forEach(material => {
                const calc = calcItemMaterial(material);

                rows.push(row('material', [
                    cell('', { align: 'center' }),
                    cell(`• ${material.name || ''}`, { style: 'material' }),
                    cell(material.unit || '', { align: 'center' }),
                    cell(calc.qty, { align: 'center', int: true }),
                    calc.skipped
                        ? cell(text.customer, { align: 'center', style: 'material' })
                        : cell(Number(material.price_client) || 0, { align: 'right', money: true }),
                    calc.skipped ? cell('—', { align: 'center' }) : cell(calc.client, { align: 'right', money: true })
                ]));
            });
        });

        rows.push(row('sectionTotal', [
            cell(text.sectionTotal, { colspan: 5, align: 'right', style: 'total' }),
            cell(sectionTotal, { align: 'right', style: 'total', money: true })
        ]));
    });

    return rows;
}
