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
import { log, toast, escapeHtml, formatMoney, formatNumber, roundMoney } from '../utils.js';

const DOCS = CONFIG.ESTIMATE?.DOCS || [];

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
// ДОКУМЕНТЫ: СТРОКИ ТАБЛИЦ
// =====================================================================
// Одна и та же структура идёт и в Excel, и в PDF: массив заголовков + массив
// строк. Так документ собирается ОДИН раз, а форматы лишь рисуют его.

/** Сведения о документе по его коду ('koshtorys9' и т.д.). */
export function getDocInfo(docType) {
    return DOCS.find(doc => doc.value === docType) || DOCS[0] || {
        value: 'koshtorys6', label: 'Кошторис'
    };
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
 * Таблица документа: заголовки + строки + с какой колонки значения числовые
 * (Excel записывает числа числами — по ним считают формулы).
 * Многоточие «...и т.д.» здесь неуместно: каждый документ описан целиком.
 */
export function buildDocTable(estimate, totals, docType) {
    if (docType === 'naryad') return buildNaryadTable(totals);
    if (docType === 'materials') return buildMaterialsTable(estimate, totals);
    return buildKoshtorysTable(totals, docType === 'koshtorys9');
}

/** Наряд: только работы по нарядным ценам — то, что получает бригада. */
function buildNaryadTable(totals) {
    const headers = ['№', 'Найменування робіт', 'Од.', 'К-сть', 'Ціна (наряд)', 'Сума'];
    const rows = [];
    let index = 0;

    totals.sections.forEach((section, sectionIndex) => {
        rows.push([`${sectionIndex + 1}. ${section.section.name}`, '', '', '', '', '']);

        section.rows.forEach(({ item, sums }) => {
            index += 1;
            rows.push([
                index,
                item.name || '',
                item.unit || '',
                Number(item.quantity) || 0,
                Number(item.price_worker) || 0,
                sums.workWorker
            ]);
        });

        rows.push(['', `Разом за розділом ${sectionIndex + 1}`, '', '', '', section.workerTotal]);
    });

    rows.push(['', 'ВСЬОГО ЗА НАРЯДОМ', '', '', '', totals.naryadTotal]);

    return { headers, rows, numericFrom: 3 };
}

/** Ведомость материалов: что и сколько закупать по всей смете. */
function buildMaterialsTable(estimate, totals) {
    const headers = ['№', 'Матеріал', 'Од.', 'К-сть', 'Ціна закупівлі', 'Сума', 'Давальницький'];
    const rows = aggregateMaterials(estimate).map((material, index) => [
        index + 1,
        material.name || '',
        material.unit,
        material.qty,
        material.pricePurchase,
        material.sum,
        material.isCustomerSupplied ? 'так (у суму не входить)' : ''
    ]);

    rows.push(['', 'ВСЬОГО ДО ЗАКУПІВЛІ', '', '', '', totals.matWorker, '']);

    return { headers, rows, numericFrom: 3 };
}

/**
 * Кошторис: 6 граф — компактный (для печати), 9 граф — полный, с материалами
 * отдельными строками под работой.
 */
function buildKoshtorysTable(totals, wide) {
    const headers = wide
        ? ['№', 'Найменування', 'Од. вим.', 'К-сть', 'Ціна за од.', 'Сума робіт',
            'Витрати на матеріали', 'Разом за позицією', 'Примітка']
        : ['№', 'Найменування', 'Од. вим.', 'К-сть', 'Ціна за од.', 'Сума'];

    const width = headers.length;
    const fit = (row) => {
        const result = row.slice(0, width);
        while (result.length < width) result.push('');
        return result;
    };

    const rows = [];
    let index = 0;

    totals.sections.forEach((section, sectionIndex) => {
        rows.push(fit([`${sectionIndex + 1}. ${section.section.name}`]));

        section.rows.forEach(({ item, sums }) => {
            index += 1;

            if (wide) {
                rows.push(fit([
                    index,
                    item.name || '',
                    item.unit || '',
                    Number(item.quantity) || 0,
                    Number(item.price_client) || 0,
                    sums.workClient,
                    sums.matClient,
                    sums.clientTotal,
                    sums.matCount > 0 ? `матеріалів: ${sums.matCount}` : ''
                ]));

                (item.materials || []).forEach(material => {
                    const calc = calcItemMaterial(material);
                    rows.push(fit([
                        '',
                        `   • ${material.name || ''}`,
                        material.unit || '',
                        calc.qty,
                        Number(material.price_client) || 0,
                        '',
                        calc.client,
                        '',
                        calc.skipped ? 'давальницький' : ''
                    ]));
                });
            } else {
                rows.push(fit([
                    index,
                    item.name || '',
                    item.unit || '',
                    Number(item.quantity) || 0,
                    Number(item.price_client) || 0,
                    sums.clientTotal
                ]));
            }
        });

        rows.push(fit([
            '',
            `Разом за розділом ${sectionIndex + 1}`,
            '',
            '',
            '',
            roundMoney(section.workClient + section.matClient),
            wide ? section.matClient : '',
            wide ? section.clientTotal : '',
            ''
        ]));
    });

    (totals.limits || []).forEach(({ limit, amount }) => {
        rows.push(fit([
            '',
            `${limit.name} (${limit.percent}% ${limitBaseLabel(limit.base)})`,
            '', '', '', amount
        ]));
    });

    const worksAndMaterials = roundMoney(totals.workClient + totals.matClient);

    rows.push(fit(['', 'РАЗОМ', '', '', '', worksAndMaterials, wide ? totals.matClient : '', wide ? worksAndMaterials : '']));

    if (totals.vatAmount > 0) {
        rows.push(fit(['', `ПДВ ${totals.vatPercent}%`, '', '', '', totals.vatAmount]));
    }

    rows.push(fit(['', 'ВСЬОГО ДО СПЛАТИ', '', '', '', totals.grandTotal]));

    return { headers, rows, numericFrom: 3 };
}

// =====================================================================
// ШАПКА ДОКУМЕНТА
// =====================================================================
// Реквизиты своей компании (одна строка в базе), номер и дата сметы, заказчик
// и объект. И в Excel, и в PDF — одни и те же строки, поэтому документ
// выглядит одинаково в обоих форматах.

function documentHeader(estimate, company, docInfo, totals) {
    const money = (value) => Number(value) || 0;

    return {
        company: company || {},
        title: docInfo?.label || 'Кошторис',
        number: estimate?.number || '',
        date: new Date().toLocaleDateString('ru-RU'),
        client: estimate?.client?.name || '',
        object: estimate?.object_name || estimate?.title || '',
        notes: estimate?.notes || '',
        totals: {
            works: money(totals?.workClient),
            materials: money(totals?.matClient),
            limits: money(totals?.limitsTotal),
            vat: money(totals?.vatAmount),
            total: money(totals?.grandTotal)
        }
    };
}

/** Имя файла документа: «Кошторис_00002_2026_Покрівля». */
export function docFileName(estimate, docInfo, extension) {
    const number = String(estimate?.number || '').replace(/\//g, '_');
    const title = safeFilePart(estimate?.title || estimate?.object_name || '');
    const doc = safeFilePart(docInfo?.label || 'smeta');
    return `${doc}_${number}_${title}.${extension}`;
}

// =====================================================================
// EXCEL
// =====================================================================

/**
 * Выгружает документ сметы в .xlsx.
 *
 * Числа записываем числами (aoa_to_sheet + формат колонок): в Excel по ним
 * считают формулы, а текст «12 345,60 грн» не посчитать.
 */
export function exportEstimateExcel(estimate, company, docType) {
    if (typeof XLSX === 'undefined') {
        toast('Библиотека XLSX не загружена', 'error');
        return false;
    }

    const totals = calcEstimate(estimate);
    const docInfo = getDocInfo(docType);
    const { headers, rows } = buildDocTable(estimate, totals, docType);
    const head = documentHeader(estimate, company, docInfo, totals);

    const title = [];
    if (head.company.company_name) title.push([head.company.company_name]);
    title.push([head.title]);
    title.push([`№ ${head.number} від ${head.date}`]);
    if (head.client) title.push([`Замовник: ${head.client}`]);
    if (head.object) title.push([`Об'єкт: ${head.object}`]);
    title.push([]);

    const aoa = [...title, headers, ...rows, [], ['Разом до сплати', '', '', '', '', head.totals.total]];

    const sheet = XLSX.utils.aoa_to_sheet(aoa);

    // Ширина колонок: наименование — самое широкое, числа — узкие.
    sheet['!cols'] = headers.map((header) => {
        if (header === 'Найменування' || header === 'Найменування робіт' || header === 'Матеріал') {
            return { wch: 48 };
        }
        if (header === 'Примітка') return { wch: 22 };
        if (header === 'Од.' || header === 'Од. вим.') return { wch: 8 };
        if (header === '№') return { wch: 5 };
        return { wch: 14 };
    });

    // Деньги — числовой формат с двумя знаками и разделителями тысяч.
    const moneyColumns = headers
        .map((header, index) => ({ header, index }))
        .filter(({ header }) => /Ціна|Сума|Витрати|Разом|Сума/.test(header))
        .map(({ index }) => index);

    const range = XLSX.utils.decode_range(sheet['!ref']);
    for (let row = range.s.r; row <= range.e.r; row += 1) {
        moneyColumns.forEach((col) => {
            const cell = sheet[XLSX.utils.encode_cell({ r: row, c: col })];
            if (cell && typeof cell.v === 'number') cell.z = '#,##0.00';
        });
    }

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, docInfo.label.replace(/[\\/?*[\]:]/g, '').slice(0, 31));
    XLSX.writeFile(workbook, docFileName(estimate, docInfo, 'xlsx'));

    log.info(`Смета ${estimate?.number}: выгружен документ «${docInfo.label}» в Excel`);
    return true;
}

// =====================================================================
// PDF
// =====================================================================
// Способ тот же, что уже используется в проекте для PDF сметы
// (js/modules/files.js): собранную разметку рисуем в canvas (html2canvas) и
// раскладываем по страницам A4 (jsPDF). Так документ выглядит как бумажный:
// одна таблица, шапка с реквизитами, итоги внизу.

/**
 * Разметка документа: из неё собирается PDF.
 *
 * Стили — АТРИБУТАМИ, а не классами. Причина: документ живёт в отсоединённом
 * блоке и печатается один раз, а имена вида «company» или «section» в общем
 * css приложения столкнулись бы с другими правилами (и прогон
 * tools/checks/frontend-check.mjs справедливо требует, чтобы каждый класс из
 * модулей был объявлен в стилях). Атрибуты style политика CSP разрешает
 * (style-src 'unsafe-inline'), как и в существующей генерации PDF
 * (js/modules/files.js).
 */
export function buildDocHtml(estimate, head, table, docType) {
    const cell = 'border:1px solid #9ca3af;padding:4px 6px;vertical-align:top';
    const numCell = `${cell};text-align:right;white-space:nowrap`;
    const headCell = `${cell};background:#f3f4f6;text-align:left;font-weight:600`;
    const tableStyle = 'width:100%;border-collapse:collapse;margin-top:12px;font-size:11px';

    const headRows = [
        head.company.company_name
            ? `<div style="font-size:18px;font-weight:700">${escapeHtml(head.company.company_name)}</div>`
            : '',
        head.company.phone || head.company.email || head.company.address
            ? `<div style="font-size:11px;color:#4b5563;margin-bottom:10px">${escapeHtml([
                head.company.address,
                head.company.phone ? `тел. ${head.company.phone}` : '',
                head.company.email || ''
            ].filter(Boolean).join(' · '))}</div>`
            : ''
    ].join('');

    const bodyRows = table.rows.map((row) => {
        const isSection = typeof row[1] === 'string' && /^\d+\.\s/.test(row[1]);
        const isTotal = typeof row[1] === 'string' && /^(РАЗОМ|ВСЬОГО|ПДВ|Разом за розділом)/.test(row[1]);
        const rowStyle = isSection
            ? ' style="background:#eef2ff;font-weight:600"'
            : (isTotal ? ' style="font-weight:700"' : '');

        const cells = row.map((value, index) => {
            if (typeof value === 'number' && index >= table.numericFrom) {
                return `<td style="${numCell}">${formatNumber(value, 2)}</td>`;
            }
            return `<td style="${cell}">${escapeHtml(value)}</td>`;
        }).join('');

        return `<tr${rowStyle}>${cells}</tr>`;
    }).join('');

    const headers = table.headers.map((header, index) => {
        const style = index >= table.numericFrom ? `${headCell};text-align:right` : headCell;
        return `<th style="${style}">${escapeHtml(header)}</th>`;
    }).join('');

    const footer = docType === 'naryad'
        ? ''
        : `<div style="margin-top:12px;font-size:12px">
            Роботи: <b>${formatMoney(head.totals.works)}</b> ·
            Матеріали: <b>${formatMoney(head.totals.materials)}</b>
            ${head.totals.limits > 0 ? ` · Лімітовані витрати: <b>${formatMoney(head.totals.limits)}</b>` : ''}
            ${head.totals.vat > 0 ? ` · ПДВ: <b>${formatMoney(head.totals.vat)}</b>` : ''}
            <div style="font-size:14px;font-weight:700;margin-top:6px">
                До сплати: ${formatMoney(head.totals.total)}
            </div>
        </div>`;

    return `
        <div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#111827">
            ${headRows}
            <h1 style="font-size:20px;font-weight:700;margin:6px 0 2px">${escapeHtml(head.title)}</h1>
            <div style="font-size:12px;color:#374151;margin-bottom:4px">
                № ${escapeHtml(head.number)} від ${escapeHtml(head.date)}
            </div>
            ${head.client ? `<div style="font-size:12px;color:#374151">Замовник: <b>${escapeHtml(head.client)}</b></div>` : ''}
            ${head.object ? `<div style="font-size:12px;color:#374151">Об'єкт: ${escapeHtml(head.object)}</div>` : ''}
            <table style="${tableStyle}">
                <thead><tr>${headers}</tr></thead>
                <tbody>${bodyRows}</tbody>
            </table>
            ${footer}
            ${head.notes
                ? `<div style="margin-top:10px;font-size:11px;color:#374151;white-space:pre-wrap">${escapeHtml(head.notes)}</div>`
                : ''}
        </div>
    `;
}


/**
 * Скачивает документ сметы в PDF.
 * @returns {Promise<boolean>} — получилось ли собрать файл
 */
export async function exportEstimatePdf(estimate, company, docType) {
    if (typeof html2canvas === 'undefined' || !window.jspdf?.jsPDF) {
        toast('Библиотеки html2canvas или jsPDF не загружены', 'error');
        return false;
    }

    const totals = calcEstimate(estimate);
    const docInfo = getDocInfo(docType);
    const table = buildDocTable(estimate, totals, docType);
    const head = documentHeader(estimate, company, docInfo, totals);
    const wide = docType === 'koshtorys9' || docType === 'materials';

    const wrapper = document.createElement('div');
    wrapper.style.position = 'fixed';
    wrapper.style.left = '-9999px';
    wrapper.style.top = '0';
    wrapper.style.width = wide ? '1500px' : '1000px';
    wrapper.style.padding = '30px';
    wrapper.style.background = '#ffffff';
    wrapper.innerHTML = buildDocHtml(estimate, head, table, docType);

    document.body.appendChild(wrapper);

    try {
        // Ждём кадр отрисовки: html2canvas снимает уже готовый DOM.
        await new Promise(resolve => setTimeout(resolve, 400));

        const canvas = await html2canvas(wrapper, {
            scale: 2,
            useCORS: true,
            backgroundColor: '#ffffff',
            logging: false,
            windowWidth: wide ? 1500 : 1000
        });

        const { jsPDF } = window.jspdf;
        const pdf = new jsPDF({ orientation: wide ? 'landscape' : 'portrait', unit: 'mm', format: 'a4' });

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

        pdf.save(docFileName(estimate, docInfo, 'pdf'));
        log.info(`Смета ${estimate?.number}: выгружен документ «${docInfo.label}» в PDF`);
        return true;

    } catch (error) {
        log.error('Ошибка генерации PDF сметы:', error);
        toast('Ошибка генерации PDF: ' + error.message, 'error');
        return false;

    } finally {
        wrapper.remove();
    }
}
