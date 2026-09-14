// =====================================================================
// МОДУЛЬ: СМЕТЫ (Excel)
// =====================================================================
// Загрузка, парсинг и хранение смет.
//
// Логика:
//   1. Пользователь выбирает .xlsx файл.
//   2. Файл грузится в Supabase Storage (bucket 'estimates').
//   3. Файл парсится через SheetJS (ищем «Раздел:» и «Итого по разделу»).
//   4. Старые разделы объекта УДАЛЯЮТСЯ.
//   5. Новые разделы пишутся в таблицу 'sections'.
//   6. Обновляется путь к файлу в таблице 'projects'.
//
// Формат Excel (как в старом коде):
//   - Строка с «Раздел:» — начало раздела
//   - Строка с «Итого по разделу» — конец раздела
//   - Колонки: 1/0 = название, 6 = работы, 7 = материалы, 8 = итого
// =====================================================================

import { db } from '../database.js';
import {
    log, toast, escapeHtml, formatMoney,
    formatDate, lockButton
} from '../utils.js';
import { requirePermission, getEmployee } from '../permissions.js';
import { CONFIG } from '../config.js';

// =====================================================================
// ЗАГРУЗКА ФАЙЛА + ПАРСИНГ + СОХРАНЕНИЕ
// =====================================================================

/**
 * Загружает и парсит смету для указанного объекта.
 * @param {number} projectId
 * @param {File} file — .xlsx файл
 */
export async function uploadEstimate(projectId, file) {
    if (!projectId) {
        toast('Объект не выбран', 'error');
        return { success: false };
    }

    if (!file) {
        toast('Файл не выбран', 'error');
        return { success: false };
    }

    log.info(`Загрузка сметы: ${file.name} для объекта #${projectId}`);

    // 1. Парсим Excel
    const parseResult = await parseExcelFile(file);

    if (!parseResult.success) {
        toast('Ошибка парсинга: ' + parseResult.error, 'error');
        return { success: false };
    }

    const sections = parseResult.sections;
    log.info(`Распарсено разделов: ${sections.length}`);

    if (sections.length === 0) {
        toast('В файле не найдено ни одного раздела. Проверь формат сметы.', 'error');
        return { success: false };
    }

    // 2. Загружаем файл в Storage
    const path = `project_${projectId}/${Date.now()}_${file.name}`;
    const uploadResult = await db.uploadFile(CONFIG.STORAGE.ESTIMATES_BUCKET, path, file);

    if (uploadResult.error) {
        toast('Ошибка загрузки файла: ' + uploadResult.error.message, 'error');
        return { success: false };
    }

    log.info(`Файл загружен: ${uploadResult.path}`);

    // 3. Удаляем старые разделы объекта
    const { error: deleteError } = await db.remove('sections', { project_id: projectId });

    if (deleteError) {
        log.error('Не удалось удалить старые разделы:', deleteError.message);
    }

    // 4. Вставляем новые разделы
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

    // 5. Обновляем запись объекта (путь, имя, дата)
    const { error: updateError } = await db.update('projects', {
        estimate_file_path: uploadResult.path,
        estimate_file_name: file.name,
        estimate_uploaded_at: new Date().toISOString()
    }, { id: projectId });

    if (updateError) {
        log.error('Не удалось обновить объект:', updateError.message);
    }

    log.info('✅ Смета успешно загружена и разобрана');
    return { success: true, sectionsCount: sections.length };
}

// =====================================================================
// ПАРСИНГ EXCEL
// =====================================================================

/**
 * Парсит Excel-файл и возвращает массив разделов.
 * @param {File} file
 * @returns {Promise<{ success: boolean, sections?: Array, error?: string }>}
 */
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

        reader.onerror = () => {
            resolve({ success: false, error: 'Ошибка чтения файла' });
        };

        reader.readAsArrayBuffer(file);
    });
}

/**
 * Парсит строки Excel и возвращает разделы.
 * Логика: ищем «Раздел:» (начало) и «Итого по разделу» (конец).
 */
function parseRows(rows) {
    const sections = [];
    let currentSection = null;

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (!row || row.length === 0) continue;

        // Ищем текст в колонках 0 и 1 (иногда текст в одной из них)
        const rowText = String(row[1] || row[0] || '').trim().toLowerCase();

        // Начало раздела
        if (rowText.includes('раздел:')) {
            if (currentSection) {
                // Предыдущий раздел не был закрыт «Итого» — ошибка
                return {
                    success: false,
                    error: `Раздел «${currentSection.name}» не имеет строки «Итого по разделу». Проверь формат файла.`
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

        // Конец раздела — «Итого по разделу»
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

    // Если последний раздел не закрыт «Итого» — ошибка
    if (currentSection) {
        return {
            success: false,
            error: `Раздел «${currentSection.name}» не имеет строки «Итого по разделу». Проверь формат файла.`
        };
    }

    if (sections.length === 0) {
        return {
            success: false,
            error: 'Не найдено ни одного раздела. Проверь, что в файле есть строки «Раздел:» и «Итого по разделу».'
        };
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

    // Удаляем файл из Storage
    if (project.estimate_file_path) {
        await db.deleteFile(CONFIG.STORAGE.ESTIMATES_BUCKET, project.estimate_file_path);
    }

    // Удаляем разделы
    await db.remove('sections', { project_id: project.id });

    // Обнуляем путь в проекте
    await db.update('projects', {
        estimate_file_path: null,
        estimate_file_name: null,
        estimate_uploaded_at: null
    }, { id: project.id });

    toast('Смета удалена', 'success');
    return { success: true };
}

// =====================================================================
// UI — БЛОК ФАЙЛОВ (загрузка сметы)
// =====================================================================

/**
 * Отрисовывает блок «Файлы» в карточке объекта.
 */
export function renderEstimateUI(project) {
    const container = document.getElementById('proj-subtab-files');
    if (!container) return;

    const hasEstimate = !!project.estimate_file_path;
    const canEdit = requirePermission ? true : false; // Проверку сделает requirePermission при действии

    if (hasEstimate) {
        container.innerHTML = `
            <div class="border-t pt-4 space-y-3">
                <h3 class="text-sm font-bold text-gray-700 uppercase tracking-wider">📊 Смета объекта</h3>
                <div class="p-4 bg-emerald-50 rounded-xl border border-emerald-200 space-y-3">
                    <div class="flex items-center justify-between bg-white p-3 rounded-lg border text-xs">
                        <div class="flex items-center gap-2 overflow-hidden">
                            <span class="text-2xl">📄</span>
                            <div class="min-w-0">
                                <p class="font-bold text-gray-800 truncate" title="${escapeHtml(project.estimate_file_name)}">${escapeHtml(project.estimate_file_name)}</p>
                                <p class="text-[10px] text-gray-400">Загружено: ${formatDate(project.estimate_uploaded_at)}</p>
                            </div>
                        </div>
                        <div class="flex gap-2 shrink-0">
                            <button onclick="window.viewEstimateFile(${project.id})" class="bg-emerald-100 hover:bg-emerald-200 text-[#15803d] px-3 py-1.5 rounded-lg font-semibold transition">👁 Оригинал</button>
                            <button onclick="window.deleteEstimateUI(${project.id})" class="bg-red-50 hover:bg-red-100 text-red-500 px-2 py-1.5 rounded-lg transition">🗑</button>
                        </div>
                    </div>
                    <p class="text-xs text-emerald-800">
                        ✅ Смета разобрана. Разделы доступны во вкладке <b>📊 План-факт</b>.
                    </p>
                </div>
            </div>
        `;
    } else {
        container.innerHTML = `
            <div class="border-t pt-4 space-y-3">
                <h3 class="text-sm font-bold text-gray-700 uppercase tracking-wider">📊 Загрузка файла сметы (Excel)</h3>
                <div class="p-4 bg-gray-50 rounded-xl border space-y-3">
                    <p class="text-xs text-gray-500">
                        Смета ещё не загружена. Загрузи файл Excel (.xlsx), чтобы автоматически сформировать разделы,
                        объёмы и сметную стоимость.
                    </p>
                    <div class="flex flex-col sm:flex-row gap-2">
                        <input type="file" id="estimate-file-input-${project.id}" accept=".xlsx, .xls"
                               class="w-full text-xs text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-emerald-50 file:text-[#15803d] hover:file:bg-emerald-100 cursor-pointer border rounded-lg bg-white">
                        <button onclick="window.uploadEstimateUI(${project.id})" class="bg-[#15803d] hover:bg-[#166534] text-white text-xs font-semibold px-4 py-2 rounded-lg transition shadow whitespace-nowrap">📤 Загрузить и разобрать</button>
                    </div>
                </div>
            </div>
        `;
    }
}

// =====================================================================
// UI — ПЛАН-ФАКТ (список разделов)
// =====================================================================

/**
 * Отрисовывает список разделов в подвкладке «План-факт».
 */
export async function renderSectionsUI(project) {
    const container = document.getElementById('proj-subtab-planfact');
    if (!container) return;

    container.innerHTML = '<p class="text-center text-gray-400 py-6 text-sm">Загрузка разделов...</p>';

    const { data: sections, error } = await loadSections(project.id);

    if (error) {
        container.innerHTML = '<p class="text-center text-red-500 py-6 text-sm">Ошибка загрузки разделов</p>';
        return;
    }

    if (!sections || sections.length === 0) {
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

    // Итоги
    let totalWorks = 0;
    let totalMaterials = 0;
    let totalAll = 0;

    sections.forEach(s => {
        totalWorks += Number(s.plan_works) || 0;
        totalMaterials += Number(s.plan_materials) || 0;
        totalAll += Number(s.plan_total) || 0;
    });

    // Заголовок с итогами
    const headerHtml = `
        <div class="bg-emerald-600 text-white rounded-xl p-3 flex flex-wrap justify-between items-center gap-2 text-xs font-bold">
            <span>📊 Всего разделов: ${sections.length}</span>
            <span>🛠 Работы: ${formatMoney(totalWorks)}</span>
            <span>📦 Материалы: ${formatMoney(totalMaterials)}</span>
            <span class="bg-emerald-700 px-2 py-1 rounded">💰 Итого: ${formatMoney(totalAll)}</span>
        </div>
    `;

    // Список разделов
    const sectionsHtml = sections.map((sec, idx) => {
        const planTotal = Number(sec.plan_total) || 0;
        const planWorks = Number(sec.plan_works) || 0;
        const planMaterials = Number(sec.plan_materials) || 0;

        return `
            <div class="border rounded-xl bg-white overflow-hidden transition shadow-sm">
                <div class="p-4 flex flex-col md:flex-row justify-between items-start md:items-center gap-3">
                    <div class="flex items-center gap-2 flex-1">
                        <span class="text-xs font-bold text-gray-400 bg-gray-100 px-2 py-1 rounded">${idx + 1}</span>
                        <h4 class="font-bold text-[#166534] text-sm">${escapeHtml(sec.name)}</h4>
                    </div>
                    <div class="text-xs text-gray-600 flex flex-wrap gap-3">
                        <span>🛠 <b>${formatMoney(planWorks)}</b></span>
                        <span>📦 <b>${formatMoney(planMaterials)}</b></span>
                        <span class="text-[#15803d] font-bold">💰 ${formatMoney(planTotal)}</span>
                    </div>
                </div>
            </div>
        `;
    }).join('');

    container.innerHTML = `
        <div class="space-y-3">
            ${headerHtml}
            <div class="space-y-2">
                ${sectionsHtml}
            </div>
        </div>
    `;
}

// =====================================================================
// UI — ОБРАБОТЧИКИ
// =====================================================================

/**
 * Обработчик кнопки «Загрузить и разобрать».
 */
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

        // Обновляем карточку объекта
        const project = window.__getCurrentProject?.();
        if (project) {
            // Перезагружаем проект из БД (обновляем пути)
            const { data } = await db.select('projects', {
                select: '*, foreman:employees(id, name, position, phone, status)',
                filters: { id: projectId },
                single: true
            });

            if (data) {
                renderEstimateUI(data);
                await renderSectionsUI(data);
            }
        }
    } else {
        toast('Не удалось загрузить смету', 'error');
    }
}

/**
 * Просмотр оригинала сметы (скачивание).
 */
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
        3600 // 1 час
    );

    if (error || !url) {
        toast('Ошибка получения ссылки', 'error');
        return;
    }

    // Открываем в новой вкладке
    window.open(url, '_blank');
}

/**
 * Удаление сметы (UI-обёртка).
 */
export async function deleteEstimateUI(projectId) {
    const { data: project } = await db.select('projects', {
        filters: { id: projectId },
        single: true
    });

    if (!project) return;

    const result = await deleteEstimate(project);

    if (result.success) {
        // Обновляем карточку объекта
        const updatedProject = { ...project, estimate_file_path: null, estimate_file_name: null, estimate_uploaded_at: null };
        renderEstimateUI(updatedProject);
        await renderSectionsUI(updatedProject);
    }
}

// =====================================================================
// ГЛОБАЛЬНЫЕ ФУНКЦИИ
// =====================================================================

window.uploadEstimateUI = uploadEstimateUI;
window.viewEstimateFile = viewEstimateFile;
window.deleteEstimateUI = deleteEstimateUI;
window.renderSectionsUI = renderSectionsUI;
window.renderEstimateUI = renderEstimateUI;