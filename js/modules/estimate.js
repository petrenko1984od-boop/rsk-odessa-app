// =====================================================================
// МОДУЛЬ: СМЕТЫ (Excel)
// =====================================================================
// Загрузка, парсинг и хранение смет.
// + Отображение план-факта с фактическими расходами.
// + UI блока сметы в карточке объекта (в контейнере #estimate-block).
//
// ВАЖНО: renderSectionsUI принимает:
//   - project      — объект проекта
//   - expensesMap  — { [section_id]: [operations] }
//   - sectionsList — массив разделов
// =====================================================================

import { db } from '../database.js';
import {
    log, toast, escapeHtml, formatMoney,
    formatDate
} from '../utils.js';
import { requirePermission } from '../permissions.js';
import { CONFIG } from '../config.js';
import { getCategoryLabel } from './cash.js';
import { canManageFiles } from './files.js';

// =====================================================================
// УТИЛИТА: ОЧИСТКА ИМЕНИ ФАЙЛА
// =====================================================================

function sanitizeFileName(originalName) {
    const lastDot = originalName.lastIndexOf('.');
    const namePart = lastDot > 0 ? originalName.slice(0, lastDot) : originalName;
    const ext = lastDot > 0 ? originalName.slice(lastDot) : '';

    const translitMap = {
        'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'e','ж':'zh','з':'z',
        'и':'i','й':'y','к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r',
        'с':'s','т':'t','у':'u','ф':'f','х':'h','ц':'ts','ч':'ch','ш':'sh','щ':'shch',
        'ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya',
        'А':'A','Б':'B','В':'V','Г':'G','Д':'D','Е':'E','Ё':'E','Ж':'Zh','З':'Z',
        'И':'I','Й':'Y','К':'K','Л':'L','М':'M','Н':'N','О':'O','П':'P','Р':'R',
        'С':'S','Т':'T','У':'U','Ф':'F','Х':'H','Ц':'Ts','Ч':'Ch','Ш':'Sh','Щ':'Shch',
        'Ъ':'','Ы':'Y','Ь':'','Э':'E','Ю':'Yu','Я':'Ya'
    };

    let result = '';
    for (const ch of namePart) {
        if (translitMap[ch]) result += translitMap[ch];
        else if (/[a-zA-Z0-9._-]/.test(ch)) result += ch;
        else result += '_';
    }
    result = result.replace(/_+/g, '_').replace(/^_|_$/g, '');
    if (!result) result = 'estimate';
    if (result.length > 80) result = result.slice(0, 80);

    return result + ext.toLowerCase();
}

// =====================================================================
// ЗАГРУЗКА ФАЙЛА + ПАРСИНГ + СОХРАНЕНИЕ
// =====================================================================

export async function uploadEstimate(projectId, file) {
    if (!projectId) { toast('Объект не выбран', 'error'); return { success: false }; }
    if (!file) { toast('Файл не выбран', 'error'); return { success: false }; }

    log.info(`Загрузка сметы: ${file.name} для объекта #${projectId}`);

    const parseResult = await parseExcelFile(file);

    if (!parseResult.success) {
        toast('Ошибка парсинга: ' + parseResult.error, 'error');
        return { success: false };
    }

    const sections = parseResult.sections;
    log.info(`Распарсено разделов: ${sections.length}`);

    if (sections.length === 0) {
        toast('В файле не найдено ни одного раздела.', 'error');
        return { success: false };
    }

    const safeName = sanitizeFileName(file.name);
    const path = `project_${projectId}/${Date.now()}_${safeName}`;

    const uploadResult = await db.uploadFile(CONFIG.STORAGE.ESTIMATES_BUCKET, path, file);

    if (uploadResult.error) {
        toast('Ошибка загрузки файла: ' + uploadResult.error.message, 'error');
        return { success: false };
    }

    await db.remove('sections', { project_id: projectId });

    const sectionsPayload = sections.map(s => ({
        project_id: projectId,
        name: s.name,
        plan_works: s.planWorks,
        plan_materials: s.planMaterials,
        plan_total: s.planTotal
    }));

    const { error: insertError } = await db.insertMany('sections', sectionsPayload);

    if (insertError) {
        toast('Ошибка сохранения разделов: ' + insertError.message, 'error');
        return { success: false };
    }

    await db.update('projects', {
        estimate_file_path: uploadResult.path,
        estimate_file_name: file.name,
        estimate_uploaded_at: new Date().toISOString()
    }, { id: projectId });

    log.info('✅ Смета успешно загружена и разобрана');
    return { success: true, sectionsCount: sections.length };
}

function parseExcelFile(file) {
    return new Promise((resolve) => {
        const reader = new FileReader();

        reader.onload = (e) => {
            try {
                const data = new Uint8Array(e.target.result);
                const workbook = XLSX.read(data, { type: 'array' });
                const firstSheetName = workbook.SheetNames[0];
                const worksheet = workbook.Sheets[firstSheetName];
                const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

                const result = parseRows(rows);

                if (!result.success) {
                    resolve({ success: false, error: result.error });
                    return;
                }

                resolve({ success: true, sections: result.sections });

            } catch (err) {
                log.error('Ошибка чтения Excel:', err);
                resolve({ success: false, error: 'Не удалось прочитать файл' });
            }
        };

        reader.onerror = () => resolve({ success: false, error: 'Ошибка чтения файла' });
        reader.readAsArrayBuffer(file);
    });
}

function parseRows(rows) {
    const sections = [];
    let currentSection = null;

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (!row || row.length === 0) continue;

        const rowText = String(row[1] || row[0] || '').trim().toLowerCase();

        if (rowText.includes('раздел:')) {
            if (currentSection) {
                return {
                    success: false,
                    error: `Раздел «${currentSection.name}» не имеет строки «Итого по разделу».`
                };
            }

            currentSection = {
                name: String(row[1] || row[0] || '').trim(),
                planWorks: 0,
                planMaterials: 0,
                planTotal: 0
            };
            continue;
        }

        if (rowText.includes('итого по разделу') && currentSection) {
            const pWorks = parseFloat(row[6]) || 0;
            const pMat = parseFloat(row[7]) || 0;
            const pTot = parseFloat(row[8]) || (pWorks + pMat);

            currentSection.planWorks = pWorks;
            currentSection.planMaterials = pMat;
            currentSection.planTotal = pTot;

            sections.push(currentSection);
            currentSection = null;
        }
    }

    if (currentSection) {
        return {
            success: false,
            error: `Раздел «${currentSection.name}» не имеет строки «Итого по разделу».`
        };
    }

    if (sections.length === 0) {
        return { success: false, error: 'Не найдено ни одного раздела.' };
    }

    return { success: true, sections };
}

// =====================================================================
// ЗАГРУЗКА РАЗДЕЛОВ
// =====================================================================

export async function loadSections(projectId) {
    const { data, error } = await db.select('sections', {
        filters: { project_id: projectId },
        orderBy: { column: 'id', asc: true }
    });

    if (error) {
        log.error('Ошибка загрузки разделов:', error.message);
        return { data: [], error };
    }

    return { data: data || [], error: null };
}

// =====================================================================
// УДАЛЕНИЕ СМЕТЫ
// =====================================================================

export async function deleteEstimate(project) {
    if (!requirePermission('edit_project')) {
        toast('Только Администратор может удалять сметы', 'error');
        return { success: false };
    }

    if (!confirm(`Удалить смету объекта «${project.name}»?\n\nВсе разделы план-факта будут удалены.`)) {
        return { success: false };
    }

    if (project.estimate_file_path) {
        await db.deleteFile(CONFIG.STORAGE.ESTIMATES_BUCKET, project.estimate_file_path);
    }

    await db.remove('sections', { project_id: project.id });

    await db.update('projects', {
        estimate_file_path: null,
        estimate_file_name: null,
        estimate_uploaded_at: null
    }, { id: project.id });

    toast('Смета удалена', 'success');
    return { success: true };
}

// =====================================================================
// UI — БЛОК СМЕТЫ (в контейнере #estimate-block)
// =====================================================================

/**
 * Рендерит блок сметы в контейнере #estimate-block.
 * Кнопка «Оригинал» (xlsx) — только для редакторов.
 * Кнопка «📥 PDF» — для всех.
 * Кнопка «🗑 Удалить» — только для редакторов.
 */
export function renderEstimateUI(project) {
    const container = document.getElementById('estimate-block');
    if (!container) return;

    const hasEstimate = !!project.estimate_file_path;
    const canManage = canManageFiles();

    if (hasEstimate) {
        container.innerHTML = `
            <div class="p-4 bg-emerald-50 rounded-xl border border-emerald-200 space-y-3">
                <div class="flex items-center justify-between bg-white p-3 rounded-lg border text-xs flex-wrap gap-2">
                    <div class="flex items-center gap-2 overflow-hidden min-w-0 flex-1">
                        <span class="text-2xl">📄</span>
                        <div class="min-w-0">
                            <p class="font-bold text-gray-800 truncate" title="${escapeHtml(project.estimate_file_name)}">${escapeHtml(project.estimate_file_name)}</p>
                            <p class="text-[10px] text-gray-400">Загружено: ${formatDate(project.estimate_uploaded_at)}</p>
                        </div>
                    </div>
                    <div class="flex gap-2 shrink-0">
                        ${canManage ? `
                            <button onclick="window.viewEstimateFile(${project.id})" 
                                    class="bg-emerald-100 hover:bg-emerald-200 text-[#15803d] px-3 py-1.5 rounded-lg font-semibold transition"
                                    title="Скачать оригинал xlsx">
                                👁 Оригинал
                            </button>
                        ` : ''}
                        <button onclick="window.downloadEstimatePDF()" 
                                class="bg-blue-100 hover:bg-blue-200 text-blue-700 px-3 py-1.5 rounded-lg font-semibold transition"
                                title="Скачать PDF">
                            📥 PDF
                        </button>
                        ${canManage ? `
                            <button onclick="window.deleteEstimateUI(${project.id})" 
                                    class="bg-red-50 hover:bg-red-100 text-red-500 px-2 py-1.5 rounded-lg transition"
                                    title="Удалить смету">
                                🗑
                            </button>
                        ` : ''}
                    </div>
                </div>
                <p class="text-xs text-emerald-800">
                    ✅ Смета разобрана. Разделы доступны во вкладке <b>📊 План-факт</b>.
                </p>
            </div>
        `;
    } else {
        if (canManage) {
            container.innerHTML = `
                <div class="p-4 bg-gray-50 rounded-xl border space-y-3">
                    <p class="text-xs text-gray-500">
                        Смета ещё не загружена. Загрузите файл Excel (.xlsx), чтобы автоматически сформировать разделы.
                    </p>
                    <div class="flex flex-col sm:flex-row gap-2">
                        <input type="file" id="estimate-file-input-${project.id}" accept=".xlsx, .xls"
                               class="w-full text-xs text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-emerald-50 file:text-[#15803d] hover:file:bg-emerald-100 cursor-pointer border rounded-lg bg-white">
                        <button onclick="window.uploadEstimateUI(${project.id})" class="bg-[#15803d] hover:bg-[#166534] text-white text-xs font-semibold px-4 py-2 rounded-lg transition shadow whitespace-nowrap">📤 Загрузить и разобрать</button>
                    </div>
                </div>
            `;
        } else {
            container.innerHTML = `
                <div class="p-4 bg-gray-50 rounded-xl border text-center">
                    <p class="text-xs text-gray-500">Смета ещё не загружена. Загружает Главный инженер / Администратор / Инженер ПТО.</p>
                </div>
            `;
        }
    }
}

// =====================================================================
// UI — ПЛАН-ФАКТ (план / факт / остаток + операции)
// =====================================================================

export function renderSectionsUI(project, expensesMap = {}, sectionsList = null) {
    const container = document.getElementById('proj-subtab-planfact');
    if (!container) return;

    const sectionsData = sectionsList || [];

    if (sectionsData.length === 0) {
        container.innerHTML = `
            <div class="p-6 bg-gray-50 rounded-xl border text-center space-y-2">
                <h3 class="text-sm font-bold text-gray-700 uppercase tracking-wider">📊 План-факт</h3>
                <p class="text-xs text-gray-500">
                    Разделы появятся здесь после загрузки файла сметы на вкладке <b>📁 Файлы</b>.
                </p>
            </div>
        `;
        return;
    }

    let totalPlanWorks = 0, totalPlanMaterials = 0, totalPlan = 0;
    let totalFactWorks = 0, totalFactMaterials = 0, totalFact = 0;

    sectionsData.forEach(s => {
        const ops = expensesMap[s.id] || [];
        const facts = calcFacts(ops);

        totalPlanWorks += Number(s.plan_works) || 0;
        totalPlanMaterials += Number(s.plan_materials) || 0;
        totalPlan += Number(s.plan_total) || 0;
        totalFactWorks += facts.works;
        totalFactMaterials += facts.materials;
        totalFact += facts.total;
    });

    const projectBalance = totalPlan - totalFact;

    const summaryHtml = `
        <div class="bg-emerald-600 text-white rounded-xl p-3 grid grid-cols-2 md:grid-cols-4 gap-2 text-xs font-bold">
            <div>
                <p class="text-emerald-100 text-[10px] uppercase">Разделов</p>
                <p class="text-base">${sectionsData.length}</p>
            </div>
            <div>
                <p class="text-emerald-100 text-[10px] uppercase">План</p>
                <p class="text-base">${formatMoney(totalPlan)}</p>
            </div>
            <div>
                <p class="text-emerald-100 text-[10px] uppercase">Факт</p>
                <p class="text-base">${formatMoney(totalFact)}</p>
            </div>
            <div>
                <p class="text-emerald-100 text-[10px] uppercase">${projectBalance >= 0 ? 'Осталось' : 'Перерасход'}</p>
                <p class="text-base ${projectBalance >= 0 ? 'text-white' : 'text-red-200'}">${formatMoney(Math.abs(projectBalance))}</p>
            </div>
        </div>
    `;

    const sectionsHtml = sectionsData.map((sec, idx) => {
        const ops = expensesMap[sec.id] || [];
        const facts = calcFacts(ops);

        const planWorks = Number(sec.plan_works) || 0;
        const planMaterials = Number(sec.plan_materials) || 0;
        const planTotal = Number(sec.plan_total) || 0;

        const balanceWorks = planWorks - facts.works;
        const balanceMaterials = planMaterials - facts.materials;
        const balanceTotal = planTotal - facts.total;

        const isOverWorks = facts.works > planWorks;
        const isOverMaterials = facts.materials > planMaterials;
        const isOverTotal = facts.total > planTotal;

        const colorWorks = isOverWorks ? 'text-red-600' : (facts.works > 0 ? 'text-emerald-700' : 'text-gray-400');
        const colorMaterials = isOverMaterials ? 'text-red-600' : (facts.materials > 0 ? 'text-emerald-700' : 'text-gray-400');
        const colorTotal = isOverTotal ? 'text-red-600' : (facts.total > 0 ? 'text-emerald-700' : 'text-gray-400');

        const overBadge = isOverTotal
            ? `<span class="text-[10px] bg-red-100 text-red-700 px-2 py-0.5 rounded font-bold">⚠️ Перерасход</span>`
            : (facts.total > 0
                ? `<span class="text-[10px] bg-green-100 text-green-700 px-2 py-0.5 rounded font-bold">✔ В норме</span>`
                : '');

        return `
            <div class="border rounded-xl bg-white overflow-hidden transition shadow-sm">
                <div onclick="window.toggleSectionDetails(${idx})" 
                     class="p-4 cursor-pointer hover:bg-emerald-50/40 flex flex-col md:flex-row justify-between items-start md:items-center gap-3">
                    <div class="flex items-center gap-2 flex-1">
                        <span id="section-arrow-${idx}" class="text-xs font-bold text-[#15803d] transition-transform">▼</span>
                        <span class="text-xs font-bold text-gray-400 bg-gray-100 px-2 py-1 rounded">${idx + 1}</span>
                        <h4 class="font-bold text-[#166534] text-sm">${escapeHtml(sec.name)}</h4>
                        ${overBadge}
                    </div>
                    <div class="text-xs flex flex-wrap gap-2 items-center">
                        <span class="text-gray-500">План: <b class="text-gray-800">${formatMoney(planTotal)}</b></span>
                        <span class="text-gray-500">Факт: <b class="${colorTotal}">${formatMoney(facts.total)}</b></span>
                    </div>
                </div>

                <div class="px-4 pb-3 grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
                    <div class="bg-gray-50 border rounded-lg p-3 space-y-1">
                        <p class="font-bold text-gray-500 uppercase tracking-wider text-[10px]">🛠 Работы</p>
                        <div class="flex justify-between">
                            <span class="text-gray-500">План:</span>
                            <span class="font-semibold text-gray-800">${formatMoney(planWorks)}</span>
                        </div>
                        <div class="flex justify-between">
                            <span class="text-gray-500">Факт:</span>
                            <span class="font-semibold ${colorWorks}">${formatMoney(facts.works)}</span>
                        </div>
                        <div class="flex justify-between pt-1 border-t">
                            <span class="font-bold text-gray-600">${balanceWorks >= 0 ? 'Осталось:' : 'Перерасход:'}</span>
                            <span class="font-bold ${balanceWorks >= 0 ? 'text-emerald-700' : 'text-red-600'}">${formatMoney(Math.abs(balanceWorks))}</span>
                        </div>
                    </div>

                    <div class="bg-gray-50 border rounded-lg p-3 space-y-1">
                        <p class="font-bold text-gray-500 uppercase tracking-wider text-[10px]">📦 Материалы</p>
                        <div class="flex justify-between">
                            <span class="text-gray-500">План:</span>
                            <span class="font-semibold text-gray-800">${formatMoney(planMaterials)}</span>
                        </div>
                        <div class="flex justify-between">
                            <span class="text-gray-500">Факт:</span>
                            <span class="font-semibold ${colorMaterials}">${formatMoney(facts.materials)}</span>
                        </div>
                        <div class="flex justify-between pt-1 border-t">
                            <span class="font-bold text-gray-600">${balanceMaterials >= 0 ? 'Осталось:' : 'Перерасход:'}</span>
                            <span class="font-bold ${balanceMaterials >= 0 ? 'text-emerald-700' : 'text-red-600'}">${formatMoney(Math.abs(balanceMaterials))}</span>
                        </div>
                    </div>
                </div>

                <div id="section-details-${idx}" class="hidden bg-gray-50 border-t p-4 space-y-2">
                    <p class="text-xs font-bold text-gray-700 uppercase tracking-wider border-b pb-1">📋 Операции по разделу:</p>
                    <div class="space-y-2">
                        ${renderSectionOperations(ops)}
                    </div>
                </div>
            </div>
        `;
    }).join('');

    container.innerHTML = `
        <div class="space-y-3">
            ${summaryHtml}
            <div class="space-y-2">
                ${sectionsHtml}
            </div>
        </div>
    `;
}

function calcFacts(operations) {
    let works = 0;
    let materials = 0;
    let total = 0;

    (operations || []).forEach(op => {
        const amount = Number(op.amount) || 0;
        total += amount;

        if (op.category === 'works') {
            works += amount;
        } else if (op.category === 'materials' || op.category === 'delivery') {
            materials += amount;
        }
    });

    return { works, materials, total };
}

function renderSectionOperations(operations) {
    if (!operations || operations.length === 0) {
        return `<p class="text-xs text-gray-400 italic py-2">Операций по этому разделу пока нет</p>`;
    }

    return operations.map(op => {
        const empName = op._employee?.name || 'Сотрудник';
        const categoryLabel = getCategoryLabel(op.category);
        const itemsCount = Array.isArray(op.items) ? op.items.length : 0;

        return `
            <div class="flex justify-between items-start gap-2 bg-white border rounded-lg p-2.5 text-xs">
                <div class="flex-1 min-w-0">
                    <p class="font-semibold text-gray-800">
                        ${categoryLabel}
                        ${itemsCount > 0 ? `<span class="text-[10px] text-gray-500">(${itemsCount} поз.)</span>` : ''}
                    </p>
                    <p class="text-[11px] text-gray-500 truncate">${escapeHtml(op.description || '')}</p>
                    <p class="text-[10px] text-gray-400 mt-0.5">
                        👤 ${escapeHtml(empName)} · 📅 ${formatDate(op.operation_date || op.created_at)}
                    </p>
                </div>
                <div class="flex flex-col items-end gap-1 shrink-0">
                    <span class="font-bold text-red-600">− ${formatMoney(op.amount)}</span>
                    ${op.receipt_path ? `<button onclick="event.stopPropagation(); window.viewReceipt('${escapeHtml(op.receipt_path)}')" class="text-[10px] text-blue-600 hover:underline">📎 Чек</button>` : ''}
                </div>
            </div>
        `;
    }).join('');
}

export function toggleSectionDetails(idx) {
    const detailsEl = document.getElementById(`section-details-${idx}`);
    const arrowEl = document.getElementById(`section-arrow-${idx}`);
    if (!detailsEl) return;

    if (detailsEl.classList.contains('hidden')) {
        detailsEl.classList.remove('hidden');
        if (arrowEl) arrowEl.style.transform = 'rotate(180deg)';
    } else {
        detailsEl.classList.add('hidden');
        if (arrowEl) arrowEl.style.transform = 'rotate(0deg)';
    }
}

// =====================================================================
// UI — ОБРАБОТЧИКИ
// =====================================================================

export async function uploadEstimateUI(projectId) {
    const input = document.getElementById(`estimate-file-input-${projectId}`);
    if (!input || input.files.length === 0) {
        toast('Выбери файл Excel', 'error');
        return;
    }

    const file = input.files[0];
    toast('Загружаем смету...', 'info');

    const result = await uploadEstimate(projectId, file);

    if (result.success) {
        toast(`Смета загружена! Разделов: ${result.sectionsCount}`, 'success');

        const project = window.__getCurrentProject?.();
        if (project && window.openProjectDetail) {
            setTimeout(() => {
                window.openProjectDetail(project.id);
            }, 300);
        }
    } else {
        toast('Не удалось загрузить смету', 'error');
    }
}

export async function viewEstimateFile(projectId) {
    const { data: project } = await db.select('projects', {
        filters: { id: projectId },
        single: true
    });

    if (!project || !project.estimate_file_path) {
        toast('Файл не найден', 'error');
        return;
    }

    toast('Готовим ссылку...', 'info');

    const { url, error } = await db.getFileUrl(
        CONFIG.STORAGE.ESTIMATES_BUCKET,
        project.estimate_file_path,
        3600
    );

    if (error || !url) {
        toast('Ошибка получения ссылки', 'error');
        return;
    }

    window.open(url, '_blank');
}

export async function deleteEstimateUI(projectId) {
    const { data: project } = await db.select('projects', {
        filters: { id: projectId },
        single: true
    });

    if (!project) return;

    const result = await deleteEstimate(project);

    if (result.success) {
        if (window.openProjectDetail) {
            window.openProjectDetail(projectId);
        }
    }
}

// =====================================================================
// ГЛОБАЛЬНЫЕ ФУНКЦИИ
// =====================================================================

window.uploadEstimateUI = uploadEstimateUI;
window.viewEstimateFile = viewEstimateFile;
window.deleteEstimateUI = deleteEstimateUI;
window.renderEstimateUI = renderEstimateUI;
window.toggleSectionDetails = toggleSectionDetails;