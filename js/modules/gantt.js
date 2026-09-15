// =====================================================================
// МОДУЛЬ: ГРАФИК РАБОТ (диаграмма Ганта)
// =====================================================================
// Показывает разделы сметы как полосы на временной шкале.
//
// Возможности:
//   - Админ / Гл. инженер / Инженер ПТО: задают и двигают даты (drag-and-drop).
//   - Прораб: только смотрит свои объекты + может закрывать выполненные разделы.
//
// Библиотека: Frappe Gantt (CDN, open-source, MIT-лицензия).
// =====================================================================

import { db } from '../database.js';
import {
    log, toast, escapeHtml, showModal, hideModal,
    formatDate
} from '../utils.js';
import { getEmployee } from '../permissions.js';

// =====================================================================
// СОСТОЯНИЕ
// =====================================================================

let currentGantt = null;       // Инстанс Gantt (для перерисовки)
let currentProjectId = null;
let currentSections = [];

// =====================================================================
// ПРАВА
// =====================================================================

/**
 * Может ли текущий пользователь редактировать график (даты)?
 * Только Админ / Гл. инженер / Инженер ПТО.
 */
export function canEditGantt() {
    const role = getEmployee()?.position;
    if (!role) return false;
    return role === 'Администратор' 
        || role === 'Главный инженер' 
        || role === 'Инженер ПТО';
}

/**
 * Может ли текущий пользователь закрывать раздел?
 * Только Прораб, и только для объекта, где он назначен.
 */
export function canCloseSection(project) {
    const emp = getEmployee();
    if (!emp) return false;
    if (emp.position !== 'Прораб') return false;
    return project && project.foreman_id === emp.id;
}

// =====================================================================
// ЗАГРУЗКА ДАННЫХ
// =====================================================================

/**
 * Загружает разделы объекта с датами.
 */
export async function loadGanttData(projectId) {
    currentProjectId = projectId;

    const { data, error } = await db.select('sections', {
        filters: { project_id: projectId },
        orderBy: { column: 'id', asc: true }
    });

    if (error) {
        log.error('Ошибка загрузки разделов для графика:', error.message);
        toast('Не удалось загрузить график', 'error');
        return [];
    }

    currentSections = data || [];
    return currentSections;
}

// =====================================================================
// ОТРИСОВКА
// =====================================================================

/**
 * Рисует диаграмму Ганта для объекта.
 */
export async function renderGantt(project) {
    const container = document.getElementById('gantt-container');
    if (!container) return;

    // Загружаем разделы
    const sections = await loadGanttData(project.id);

    // Если нет разделов — показать заглушку
    if (sections.length === 0) {
        container.innerHTML = `
            <div class="p-8 bg-gray-50 rounded-xl border text-center space-y-2">
                <div class="text-4xl">📅</div>
                <h3 class="text-sm font-bold text-gray-700 uppercase tracking-wider">График работ</h3>
                <p class="text-xs text-gray-500">
                    Загрузите смету на вкладке <b>📁 Файлы</b>, чтобы появились разделы для планирования.
                </p>
            </div>
        `;
        return;
    }

    // Проверяем, есть ли хотя бы одна дата
    const hasDates = sections.some(s => s.planned_start_date && s.planned_end_date);

    // Если нет дат и пользователь не может редактировать — показать заглушку
    if (!hasDates && !canEditGantt()) {
        container.innerHTML = `
            <div class="p-8 bg-gray-50 rounded-xl border text-center space-y-2">
                <div class="text-4xl">📅</div>
                <h3 class="text-sm font-bold text-gray-700 uppercase tracking-wider">График ещё не заполнен</h3>
                <p class="text-xs text-gray-500">
                    Даты работ устанавливает Главный инженер / Администратор / Инженер ПТО.
                </p>
            </div>
        `;
        return;
    }

    // Строим задачи для Gantt
    const tasks = sections
        .filter(s => s.planned_start_date && s.planned_end_date)
        .map(section => buildGanttTask(section));

    // Если нет ни одной заполненной задачи
    if (tasks.length === 0) {
        if (canEditGantt()) {
            container.innerHTML = `
                <div class="p-6 bg-amber-50 rounded-xl border border-amber-200 text-center space-y-2">
                    <div class="text-3xl">⚠️</div>
                    <h3 class="text-sm font-bold text-amber-800">Разделы есть, но даты не заданы</h3>
                    <p class="text-xs text-gray-600 mb-3">
                        Установите даты для разделов ниже — они появятся на диаграмме.
                    </p>
                    <button onclick="window.openEditDatesModal()" 
                            class="bg-[#15803d] hover:bg-[#166534] text-white px-4 py-2 rounded-lg text-sm font-semibold transition">
                        📅 Установить даты разделов
                    </button>
                </div>
            `;
        } else {
            container.innerHTML = `
                <div class="p-6 bg-gray-50 rounded-xl border text-center">
                    <p class="text-sm text-gray-500">График пока не заполнен</p>
                </div>
            `;
        }
        return;
    }

    // Кнопки управления (для редакторов)
    const controlsHtml = canEditGantt()
        ? `<div class="flex justify-end gap-2 mb-3">
               <button onclick="window.openEditDatesModal()" 
                       class="bg-[#15803d] hover:bg-[#166534] text-white px-3 py-1.5 rounded-lg text-xs font-semibold transition shadow">
                   ✏️ Редактировать даты
               </button>
               <select id="gantt-view-mode" onchange="window.changeGanttView()"
                       class="border rounded-lg px-3 py-1.5 text-xs bg-white text-gray-800 outline-none focus:ring-2 focus:ring-[#15803d]">
                   <option value="Day">📆 День</option>
                   <option value="Week" selected>📅 Неделя</option>
                   <option value="Month">📅 Месяц</option>
               </select>
           </div>`
        : `<div class="flex justify-end mb-3">
               <select id="gantt-view-mode" onchange="window.changeGanttView()"
                       class="border rounded-lg px-3 py-1.5 text-xs bg-white text-gray-800 outline-none focus:ring-2 focus:ring-[#15803d]">
                   <option value="Day">📆 День</option>
                   <option value="Week" selected>📅 Неделя</option>
                   <option value="Month">📅 Месяц</option>
               </select>
           </div>`;

    // Рендерим контейнер
    container.innerHTML = `
        <div class="space-y-3">
            ${controlsHtml}
            <div id="gantt-chart" class="bg-white rounded-xl border p-3 overflow-x-auto"></div>
            <div class="flex flex-wrap gap-3 text-[11px] text-gray-500 pt-2 border-t">
                <span class="flex items-center gap-1"><span class="w-3 h-3 rounded bg-[#15803d]"></span> План (в процессе)</span>
                <span class="flex items-center gap-1"><span class="w-3 h-3 rounded bg-emerald-500"></span> Выполнено</span>
                <span class="flex items-center gap-1"><span class="w-3 h-3 rounded bg-red-500"></span> Просрочка</span>
            </div>
        </div>
    `;

    // Инициализируем Gantt
    setTimeout(() => {
        initGanttChart(tasks);
    }, 100);
}

/**
 * Преобразует раздел сметы в задачу для Gantt.
 */
function buildGanttTask(section) {
    // Определяем статус
    let status = 'plan';
    if (section.actual_end_date) {
        // Проверяем, в срок ли закрыли
        const actual = new Date(section.actual_end_date).getTime();
        const planned = new Date(section.planned_end_date).getTime();
        status = actual <= planned ? 'done' : 'overdue_done';
    } else {
        // Проверяем, не просрочен ли план
        const today = new Date().getTime();
        const planned = new Date(section.planned_end_date).getTime();
        if (today > planned) {
            status = 'overdue';
        }
    }

    return {
        id: String(section.id),
        name: truncate(section.name, 40),
        start: section.planned_start_date,
        end: section.planned_end_date,
        progress: section.actual_end_date ? 100 : 0,
        dependencies: '',
        custom_class: `gantt-bar-${status}`,
        // Дополнительные данные для клика
        _section: section,
        _status: status
    };
}

/**
 * Инициализирует Frappe Gantt.
 */
function initGanttChart(tasks) {
    const chartContainer = document.getElementById('gantt-chart');
    if (!chartContainer) return;

    // Проверка наличия библиотеки
    if (typeof Gantt === 'undefined') {
        log.error('Frappe Gantt не загружен');
        chartContainer.innerHTML = '<p class="text-center text-red-500 py-4 text-sm">Ошибка: библиотека Gantt не загружена</p>';
        return;
    }

    // Уничтожаем старый инстанс
    if (currentGantt) {
        currentGantt = null;
        chartContainer.innerHTML = '';
    }

    const viewMode = document.getElementById('gantt-view-mode')?.value || 'Week';
    const readonly = !canEditGantt();

    try {
        currentGantt = new Gantt(chartContainer, tasks, {
            view_mode: viewMode,
            language: 'ru',
            readonly: readonly,
            bar_height: 24,
            bar_corner_radius: 3,
            arrow_curve: 5,
            padding: 18,
            date_format: 'YYYY-MM-DD',
            on_click: (task) => {
                onGanttBarClick(task);
            },
            on_date_change: (task, start, end) => {
                onGanttDateChange(task, start, end);
            },
            on_progress_change: null,
            on_view_change: (mode) => {
                log.info('Gantt view mode:', mode);
            }
        });

        log.info('✅ Диаграмма Ганта отрисована');
    } catch (err) {
        log.error('Ошибка инициализации Gantt:', err);
        chartContainer.innerHTML = '<p class="text-center text-red-500 py-4 text-sm">Ошибка отрисовки диаграммы</p>';
    }
}

/**
 * Клик по полосе диаграммы.
 */
function onGanttBarClick(task) {
    if (!task._section) return;
    openSectionDetailFromGantt(task._section);
}

/**
 * Изменение даты через drag-and-drop.
 */
async function onGanttDateChange(task, start, end) {
    if (!canEditGantt()) {
        toast('Только Администратор / Гл. инженер / Инженер ПТО могут менять даты', 'warning');
        return;
    }

    const sectionId = parseInt(task.id, 10);
    const startDate = formatDateISO(start);
    const endDate = formatDateISO(end);

    log.info(`Изменение дат раздела #${sectionId}: ${startDate} → ${endDate}`);

    const { error } = await db.update('sections', {
        planned_start_date: startDate,
        planned_end_date: endDate
    }, { id: sectionId });

    if (error) {
        toast('Ошибка сохранения дат: ' + error.message, 'error');
        return;
    }

    toast('Даты сохранены', 'success');

    // Обновляем кэш
    const sec = currentSections.find(s => s.id === sectionId);
    if (sec) {
        sec.planned_start_date = startDate;
        sec.planned_end_date = endDate;
    }
}

/**
 * Смена режима отображения.
 */
export function changeGanttView() {
    const mode = document.getElementById('gantt-view-mode')?.value;
    if (currentGantt && mode) {
        currentGantt.change_view_mode(mode);
    }
}

// =====================================================================
// МОДАЛКА РЕДАКТИРОВАНИЯ ДАТ
// =====================================================================

/**
 * Открывает модалку массового редактирования дат.
 */
export function openEditDatesModal() {
    if (!canEditGantt()) {
        toast('Нет прав на редактирование графика', 'error');
        return;
    }

    const container = document.getElementById('edit-dates-content');
    if (!container) return;

    if (currentSections.length === 0) {
        container.innerHTML = '<p class="text-center text-gray-400 py-3 text-sm">Нет разделов</p>';
        showModal('edit-dates-modal');
        return;
    }

    container.innerHTML = currentSections.map(s => `
        <div class="bg-gray-50 border rounded-lg p-3 space-y-2" data-section-id="${s.id}">
            <p class="font-semibold text-gray-800 text-xs">📌 ${escapeHtml(s.name)}</p>
            <div class="grid grid-cols-2 gap-2">
                <div>
                    <label class="block text-[10px] font-semibold text-gray-500 mb-1">Начало:</label>
                    <input type="date" 
                           class="section-start w-full border rounded-lg p-2 text-xs text-gray-800 outline-none focus:ring-2 focus:ring-[#15803d]"
                           value="${s.planned_start_date || ''}">
                </div>
                <div>
                    <label class="block text-[10px] font-semibold text-gray-500 mb-1">Окончание:</label>
                    <input type="date" 
                           class="section-end w-full border rounded-lg p-2 text-xs text-gray-800 outline-none focus:ring-2 focus:ring-[#15803d]"
                           value="${s.planned_end_date || ''}">
                </div>
            </div>
        </div>
    `).join('');

    showModal('edit-dates-modal');
}

/**
 * Сохраняет все даты из модалки.
 */
export async function saveAllDates(event) {
    event.preventDefault();

    if (!canEditGantt()) {
        toast('Нет прав', 'error');
        return;
    }

    const rows = document.querySelectorAll('#edit-dates-content [data-section-id]');
    const updates = [];

    for (const row of rows) {
        const sectionId = parseInt(row.dataset.sectionId, 10);
        const start = row.querySelector('.section-start')?.value || null;
        const end = row.querySelector('.section-end')?.value || null;

        // Проверка: если одна дата указана — обе должны быть
        if ((start && !end) || (!start && end)) {
            toast(`Раздел #${sectionId}: укажи обе даты (начало и окончание)`, 'error');
            return;
        }

        // Проверка: начало ≤ окончание
        if (start && end && start > end) {
            toast(`Раздел #${sectionId}: начало позже окончания`, 'error');
            return;
        }

        updates.push({ id: sectionId, planned_start_date: start, planned_end_date: end });
    }

    // Сохраняем всё
    let savedCount = 0;
    for (const upd of updates) {
        const { error } = await db.update('sections', {
            planned_start_date: upd.planned_start_date,
            planned_end_date: upd.planned_end_date
        }, { id: upd.id });

        if (!error) savedCount++;
    }

    toast(`Сохранено разделов: ${savedCount}`, 'success');
    hideModal('edit-dates-modal');

    // Перерисовываем график
    if (window.__getCurrentProject) {
        const project = window.__getCurrentProject();
        if (project) await renderGantt(project);
    }
}

// =====================================================================
// ЗАКРЫТИЕ РАЗДЕЛА (прораб)
// =====================================================================

/**
 * Открывает модалку подтверждения закрытия раздела.
 */
export function openSectionDetailFromGantt(section) {
    const emp = getEmployee();
    if (!emp) return;

    // Определяем статус
    const statusInfo = getSectionStatusInfo(section);

    const container = document.getElementById('section-detail-gantt-content');
    if (!container) return;

    container.innerHTML = `
        <div class="bg-emerald-50 p-3 rounded-lg border border-emerald-200 space-y-1">
            <h3 class="font-bold text-[#166534] text-base">📌 ${escapeHtml(section.name)}</h3>
            <span class="text-[10px] font-bold px-2 py-0.5 rounded ${statusInfo.bg} ${statusInfo.color}">${statusInfo.label}</span>
        </div>

        <div class="bg-gray-50 p-3 rounded-lg border space-y-2 text-xs">
            ${section.planned_start_date ? `<p><strong>📅 План начало:</strong> ${formatDate(section.planned_start_date)}</p>` : ''}
            ${section.planned_end_date ? `<p><strong>📅 План окончание:</strong> ${formatDate(section.planned_end_date)}</p>` : ''}
            ${section.actual_end_date ? `<p><strong>✅ Факт закрытия:</strong> <span class="text-emerald-700 font-semibold">${formatDate(section.actual_end_date)}</span></p>` : ''}
            ${section.planned_start_date && section.planned_end_date ? `
                <p><strong>⏱ Плановая длительность:</strong> 
                   ${Math.ceil((new Date(section.planned_end_date) - new Date(section.planned_start_date)) / (1000 * 60 * 60 * 24))} дней
                </p>
            ` : ''}
            ${section.actual_end_date && section.planned_start_date ? `
                <p><strong>⏱ Фактическая длительность:</strong> 
                   ${Math.ceil((new Date(section.actual_end_date) - new Date(section.planned_start_date)) / (1000 * 60 * 60 * 24))} дней
                </p>
            ` : ''}
        </div>

        ${section.actual_end_date ? `
            <div class="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-xs">
                <p class="font-bold text-emerald-800">✅ Раздел закрыт</p>
            </div>
        ` : ''}
    `;

    // Кнопки действий
    const actionsContainer = document.getElementById('section-detail-gantt-actions');
    if (actionsContainer) {
        let actionsHtml = '';

        // Прораб может закрыть раздел (если это его объект и раздел не закрыт)
        if (!section.actual_end_date && emp.position === 'Прораб') {
            const currentProject = window.__getCurrentProject?.();
            if (currentProject && currentProject.foreman_id === emp.id) {
                actionsHtml += `<button onclick="window.openCloseSectionModal(${section.id})" 
                                class="bg-[#15803d] hover:bg-[#166534] text-white font-semibold px-4 py-2 rounded-lg text-sm transition">
                                ✅ Отметить выполненным
                                </button>`;
            }
        }

        // Редакторы могут убрать отметку о закрытии
        if (section.actual_end_date && canEditGantt()) {
            actionsHtml += `<button onclick="window.uncloseSection(${section.id})" 
                            class="bg-amber-500 hover:bg-amber-600 text-white font-semibold px-4 py-2 rounded-lg text-sm transition">
                            ↩️ Снять отметку выполнения
                            </button>`;
        }

        actionsContainer.innerHTML = actionsHtml;
    }

    showModal('section-detail-gantt-modal');
}

/**
 * Открывает модалку закрытия раздела.
 */
export function openCloseSectionModal(sectionId) {
    const section = currentSections.find(s => s.id === sectionId);
    if (!section) {
        toast('Раздел не найден', 'error');
        return;
    }

    hideModal('section-detail-gantt-modal');

    document.getElementById('close-section-id').value = sectionId;
    document.getElementById('close-section-name').textContent = section.name;
    document.getElementById('close-section-date').valueAsDate = new Date();
    document.getElementById('close-section-comment').value = '';

    showModal('close-section-modal');
}

/**
 * Сохранение закрытия раздела.
 */
export async function confirmCloseSection(event) {
    event.preventDefault();

    const emp = getEmployee();
    if (!emp) {
        toast('Ваш аккаунт не привязан', 'error');
        return;
    }

    const sectionId = parseInt(document.getElementById('close-section-id').value, 10);
    const actualDate = document.getElementById('close-section-date').value;

    if (!actualDate) {
        toast('Укажи дату выполнения', 'error');
        return;
    }

    const { error } = await db.update('sections', {
        actual_end_date: actualDate,
        closed_by_employee_id: emp.id
    }, { id: sectionId });

    if (error) {
        toast('Ошибка: ' + error.message, 'error');
        return;
    }

    log.info('✅ Раздел закрыт:', sectionId);
    toast('Раздел отмечен выполненным', 'success');

    hideModal('close-section-modal');

    // Обновляем график
    if (window.__getCurrentProject) {
        const project = window.__getCurrentProject();
        if (project) await renderGantt(project);
    }
}

/**
 * Снять отметку о закрытии (для редакторов).
 */
export async function uncloseSection(sectionId) {
    if (!canEditGantt()) {
        toast('Нет прав', 'error');
        return;
    }

    if (!confirm('Снять отметку о выполнении раздела?')) return;

    const { error } = await db.update('sections', {
        actual_end_date: null,
        closed_by_employee_id: null
    }, { id: sectionId });

    if (error) {
        toast('Ошибка: ' + error.message, 'error');
        return;
    }

    toast('Отметка снята', 'success');
    hideModal('section-detail-gantt-modal');

    if (window.__getCurrentProject) {
        const project = window.__getCurrentProject();
        if (project) await renderGantt(project);
    }
}

// =====================================================================
// ХЕЛПЕРЫ
// =====================================================================

/**
 * Возвращает информацию о статусе раздела.
 */
export function getSectionStatusInfo(section) {
    if (section.actual_end_date) {
        // Раздел закрыт — в срок или с опозданием?
        const actual = new Date(section.actual_end_date).getTime();
        const planned = section.planned_end_date ? new Date(section.planned_end_date).getTime() : null;

        if (planned && actual <= planned) {
            return { label: '🟢 Выполнено в срок', bg: 'bg-green-100', color: 'text-green-700' };
        } else {
            return { label: '🟠 Выполнено с опозданием', bg: 'bg-amber-100', color: 'text-amber-800' };
        }
    }

    // Не закрыт — проверяем просрочку
    if (section.planned_end_date) {
        const today = new Date().getTime();
        const planned = new Date(section.planned_end_date).getTime();
        if (today > planned) {
            return { label: '🔴 Просрочено', bg: 'bg-red-100', color: 'text-red-700' };
        }
    }

    if (!section.planned_start_date || !section.planned_end_date) {
        return { label: '⚪ Даты не заданы', bg: 'bg-gray-100', color: 'text-gray-600' };
    }

    return { label: '🔵 В плане', bg: 'bg-blue-100', color: 'text-blue-700' };
}

/**
 * Формат даты в ISO (YYYY-MM-DD).
 */
function formatDateISO(date) {
    if (!date) return null;
    const d = date instanceof Date ? date : new Date(date);
    if (isNaN(d.getTime())) return null;
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function truncate(str, length) {
    if (!str) return '';
    return str.length > length ? str.substring(0, length - 1) + '…' : str;
}

// =====================================================================
// ГЛОБАЛЬНЫЕ ФУНКЦИИ
// =====================================================================

window.renderGantt = renderGantt;
window.changeGanttView = changeGanttView;
window.openEditDatesModal = openEditDatesModal;
window.openCloseSectionModal = openCloseSectionModal;
window.uncloseSection = uncloseSection;