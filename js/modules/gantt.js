// =====================================================================
// МОДУЛЬ: ГРАФИК РАБОТ (диаграмма Ганта)
// =====================================================================
// Показывает разделы сметы как полосы на временной шкале.
//
// Логика отображения:
//   - 📋 Плановая полоса — ВСЕГДА зелёная (не меняется).
//   - ✅ Фактическая полоса — синяя (в срок) или красная (с опозданием).
//
// Возможности:
//   - Админ / Гл. инженер / Инженер ПТО: задают и двигают даты.
//   - Прораб: смотрит свои объекты + может закрывать выполненные разделы.
//   - Экспорт диаграммы в PDF.
//
// Библиотеки: Frappe Gantt 0.6.1, html2canvas, jsPDF.
// =====================================================================

import { db } from '../database.js';
import {
    log, toast, escapeHtml, showModal, hideModal,
    formatDate, isExtraSectionName
} from '../utils.js';
import { can, getEmployee } from '../permissions.js';

// =====================================================================
// СОСТОЯНИЕ
// =====================================================================

let currentGantt = null;
let currentSections = [];
let currentViewMode = 'Week';

// =====================================================================
// ПРАВА
// =====================================================================

export function canEditGantt() {
    return can('edit_gantt');
}

export function canCloseSection(project) {
    const emp = getEmployee();
    if (!emp) return false;
    if (!can('close_section')) return false;
    return project && project.foreman_id === emp.id;
}

// =====================================================================
// ЗАГРУЗКА ДАННЫХ
// =====================================================================

export async function loadGanttData(projectId) {
    
    const { data, error } = await db.select('sections', {
        filters: { project_id: projectId },
        orderBy: { column: 'id', asc: true }
    });

    if (error) {
        log.error('Ошибка загрузки разделов для графика:', error.message);
        toast('Не удалось загрузить график', 'error');
        return [];
    }

    // Служебный раздел «Доп. расходы» (вне сметы) в графике не показываем:
    // у него нет плановых дат, и он не является работой по смете.
    currentSections = (data || []).filter(section => !isExtraSectionName(section.name));
    return currentSections;
}

// =====================================================================
// ОТРИСОВКА
// =====================================================================

export async function renderGantt(project) {
    const container = document.getElementById('gantt-container');
    if (!container) return;

    const sections = await loadGanttData(project.id);

    if (sections.length === 0) {
        container.innerHTML = `
            <div class="p-8 bg-gray-50 rounded-xl border text-center space-y-2">
                <div class="text-4xl">📅</div>
                <h3 class="text-sm font-bold text-gray-700 uppercase tracking-wider">График работ</h3>
                <p class="text-xs text-gray-500">
                    Разделы создаёт загрузка сметы (Администратор / Главный инженер / Инженер ПТО).
                </p>
            </div>
        `;
        return;
    }

    const hasDates = sections.some(s => s.planned_start_date && s.planned_end_date);

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

    const tasks = [];
    sections
        .filter(s => s.planned_start_date && s.planned_end_date)
        .forEach(section => {
            tasks.push(...buildGanttTasks(section));
        });

    if (tasks.length === 0) {
        if (canEditGantt()) {
            container.innerHTML = `
                <div class="p-6 bg-amber-50 rounded-xl border border-amber-200 text-center space-y-2">
                    <div class="text-3xl">⚠️</div>
                    <h3 class="text-sm font-bold text-amber-800">Разделы есть, но даты не заданы</h3>
                    <p class="text-xs text-gray-600 mb-3">
                        Установите даты для разделов ниже — они появятся на диаграмме.
                    </p>
                    <button data-action="openEditDatesModal" 
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

    const controlsHtml = canEditGantt()
        ? `<div class="flex flex-wrap justify-end gap-2 mb-3">
               <button data-action="openEditDatesModal" 
                       class="bg-[#15803d] hover:bg-[#166534] text-white px-3 py-1.5 rounded-lg text-xs font-semibold transition shadow">
                   ✏️ Редактировать даты
               </button>
               <button data-action="downloadGanttPDF" 
                       class="bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 rounded-lg text-xs font-semibold transition shadow">
                   📥 Скачать PDF
               </button>
               <select id="gantt-view-mode" data-action="changeGanttView" data-on="change"
                       class="border rounded-lg px-3 py-1.5 text-xs bg-white text-gray-800 outline-none focus:ring-2 focus:ring-[#15803d]">
                   <option value="Day" ${currentViewMode === 'Day' ? 'selected' : ''}>📆 День</option>
                   <option value="Week" ${currentViewMode === 'Week' ? 'selected' : ''}>📅 Неделя</option>
                   <option value="Month" ${currentViewMode === 'Month' ? 'selected' : ''}>📅 Месяц</option>
               </select>
           </div>`
        : `<div class="flex flex-wrap justify-end gap-2 mb-3">
               <button data-action="downloadGanttPDF" 
                       class="bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 rounded-lg text-xs font-semibold transition shadow">
                   📥 Скачать PDF
               </button>
               <select id="gantt-view-mode" data-action="changeGanttView" data-on="change"
                       class="border rounded-lg px-3 py-1.5 text-xs bg-white text-gray-800 outline-none focus:ring-2 focus:ring-[#15803d]">
                   <option value="Day" ${currentViewMode === 'Day' ? 'selected' : ''}>📆 День</option>
                   <option value="Week" ${currentViewMode === 'Week' ? 'selected' : ''}>📅 Неделя</option>
                   <option value="Month" ${currentViewMode === 'Month' ? 'selected' : ''}>📅 Месяц</option>
               </select>
           </div>`;

    container.innerHTML = `
        <div class="space-y-3">
            ${controlsHtml}
            <div id="gantt-chart" class="bg-white rounded-xl border p-3 overflow-x-auto"></div>
            <div class="flex flex-wrap gap-3 text-[11px] text-gray-500 pt-2 border-t">
                <span class="flex items-center gap-1"><span class="w-3 h-3 rounded" style="background:#15803d"></span> 📋 План</span>
                <span class="flex items-center gap-1"><span class="w-3 h-3 rounded" style="background:#3b82f6"></span> ✅ Факт (в срок)</span>
                <span class="flex items-center gap-1"><span class="w-3 h-3 rounded" style="background:#ef4444"></span> ⚠️ Факт (с опозданием)</span>
            </div>
        </div>
    `;

    setTimeout(() => {
        initGanttChart(tasks);
    }, 100);
}

/**
 * Преобразует раздел сметы в ДВЕ задачи для Gantt:
 *   1. План — зелёная полоса (всегда).
 *   2. Факт — синяя (в срок) или красная (позже плана). Только если раздел закрыт.
 */
function buildGanttTasks(section) {
    const tasks = [];

    // --- 1. Плановая полоса (ВСЕГДА зелёная) ---
    tasks.push({
        id: `plan_${section.id}`,
        name: `📋 ${truncate(section.name, 40)}`,
        start: section.planned_start_date,
        end: section.planned_end_date,
        progress: 0,
        dependencies: '',
        custom_class: 'gantt-bar-plan',
        _section: section,
        _type: 'plan',
        _color: '#15803d' // зелёный
    });

    // --- 2. Фактическая полоса (только если раздел закрыт) ---
    if (section.actual_end_date) {
        const actual = new Date(section.actual_end_date).getTime();
        const planned = new Date(section.planned_end_date).getTime();
        const isLate = actual > planned;

        tasks.push({
            id: `fact_${section.id}`,
            name: `✅ ${truncate(section.name, 40)}`,
            start: section.planned_start_date,
            end: section.actual_end_date,
            progress: 100,
            dependencies: '',
            custom_class: isLate ? 'gantt-bar-fact-late' : 'gantt-bar-fact-ok',
            _section: section,
            _type: 'fact',
            _color: isLate ? '#ef4444' : '#3b82f6' // красный / синий
        });
    }

    return tasks;
}

/**
 * Инициализирует Frappe Gantt.
 */
function initGanttChart(tasks) {
    const chartContainer = document.getElementById('gantt-chart');
    if (!chartContainer) return;

    if (typeof Gantt === 'undefined') {
        log.error('Frappe Gantt не загружен');
        chartContainer.innerHTML = '<p class="text-center text-red-500 py-4 text-sm">Ошибка: библиотека Gantt не загружена</p>';
        return;
    }

    if (currentGantt) {
        currentGantt = null;
        chartContainer.innerHTML = '';
    }

    const viewMode = document.getElementById('gantt-view-mode')?.value || currentViewMode;
    currentViewMode = viewMode;
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

        // 👇 Применяем inline-цвета по порядку
        applyBarColors(tasks);

    } catch (err) {
        log.error('Ошибка инициализации Gantt:', err);
        chartContainer.innerHTML = '<p class="text-center text-red-500 py-4 text-sm">Ошибка отрисовки диаграммы</p>';
    }
}

/**
 * Применяет inline-цвета к полосам.
 * Frappe Gantt 0.6.1 не поддерживает data-id, поэтому используем порядок полос.
 */
function applyBarColors(tasks) {
    setTimeout(() => {
        const chartContainer = document.getElementById('gantt-chart');
        if (!chartContainer) return;

        const allWrappers = chartContainer.querySelectorAll('.bar-wrapper');

        log.info(`🎨 Полос в DOM: ${allWrappers.length}, задач: ${tasks.length}`);

        if (allWrappers.length === 0) {
            log.warn('⚠️ Полосы не найдены в DOM');
            return;
        }

        allWrappers.forEach((wrapper, i) => {
            const task = tasks[i];
            if (!task || !task._color) return;

            const bar = wrapper.querySelector('.bar');
            if (bar) {
                bar.setAttribute('fill', task._color);
                bar.style.fill = task._color;
            }
        });

        log.info(`🎨 Применено цветов: ${tasks.filter(t => t._color).length}`);
    }, 300);
}

/**
 * Клик по полосе.
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

    if (!task.id.startsWith('plan_')) {
        return;
    }

    const sectionId = parseInt(task.id.replace('plan_', ''), 10);
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

    const sec = currentSections.find(s => s.id === sectionId);
    if (sec) {
        sec.planned_start_date = startDate;
        sec.planned_end_date = endDate;
    }
}

/**
 * Смена режима отображения.
 */
export async function changeGanttView() {
    const mode = document.getElementById('gantt-view-mode')?.value;
    if (!mode) return;

    currentViewMode = mode;

    const project = window.__getCurrentProject?.();
    if (project) {
        await renderGantt(project);
    }
}

// =====================================================================
// СКАЧИВАНИЕ ГРАФИКА В PDF
// =====================================================================

/**
 * Генерирует PDF с диаграммой Ганта и скачивает его.
 */
export async function downloadGanttPDF() {
    const project = window.__getCurrentProject?.();
    if (!project) {
        toast('Не удалось определить объект', 'error');
        return;
    }

    const chartContainer = document.getElementById('gantt-chart');
    if (!chartContainer || chartContainer.innerHTML.trim() === '') {
        toast('Диаграмма не отрисована', 'warning');
        return;
    }

    toast('Готовим PDF...', 'info');

    // Проверка библиотек
    if (typeof html2canvas === 'undefined' || typeof window.jspdf === 'undefined') {
        toast('Библиотеки PDF не загружены', 'error');
        log.error('html2canvas или jsPDF не найдены');
        return;
    }

    try {
        // ----- 1. Временный контейнер с заголовком, диаграммой и легендой -----
        const wrapper = document.createElement('div');
        wrapper.style.position = 'fixed';
        wrapper.style.left = '-9999px';
        wrapper.style.top = '0';
        wrapper.style.width = 'max-content';
        wrapper.style.minWidth = '0';
        wrapper.style.overflow = 'visible';
        wrapper.style.padding = '40px';
        wrapper.style.background = '#ffffff';
        wrapper.style.fontFamily = 'system-ui, -apple-system, sans-serif';
        wrapper.style.color = '#111827';

        const dateStr = new Date().toLocaleDateString('ru-RU');

        wrapper.innerHTML = `
            <div style="margin-bottom: 25px; padding-bottom: 20px; border-bottom: 3px solid #15803d;">
                <div style="font-size: 28px; font-weight: 700; color: #166534; margin-bottom: 8px;">
                    📅 График работ
                </div>
                <div style="font-size: 18px; color: #374151;">
                    Объект: <strong>${escapeHtml(project.name)}</strong>
                </div>
                <div style="font-size: 13px; color: #6b7280; margin-top: 6px;">
                    Дата формирования: ${dateStr}
                </div>
            </div>

            <div id="pdf-gantt-content" style="background: #fff;"></div>

            <div style="margin-top: 25px; padding-top: 20px; border-top: 2px solid #e5e7eb; display: flex; gap: 30px; font-size: 13px; color: #374151;">
                <div style="display: flex; align-items: center; gap: 8px;">
                    <span style="display: inline-block; width: 16px; height: 16px; border-radius: 4px; background: #15803d;"></span>
                    <span>📋 План</span>
                </div>
                <div style="display: flex; align-items: center; gap: 8px;">
                    <span style="display: inline-block; width: 16px; height: 16px; border-radius: 4px; background: #3b82f6;"></span>
                    <span>✅ Факт (в срок)</span>
                </div>
                <div style="display: flex; align-items: center; gap: 8px;">
                    <span style="display: inline-block; width: 16px; height: 16px; border-radius: 4px; background: #ef4444;"></span>
                    <span>⚠️ Факт (с опозданием)</span>
                </div>
            </div>
        `;

        // Копируем SVG диаграммы во временный контейнер
        const svgElement = chartContainer.querySelector('svg');
        if (!svgElement) {
            toast('SVG диаграммы не найден', 'error');
            return;
        }

        const svgClone = svgElement.cloneNode(true);
        const pdfContent = wrapper.querySelector('#pdf-gantt-content');

        const viewBox = svgElement.viewBox?.baseVal;
        const viewBoxX = Number(viewBox?.x) || 0;
        const viewBoxY = Number(viewBox?.y) || 0;
        const viewBoxWidth = Number(viewBox?.width) || 0;
        const viewBoxHeight = Number(viewBox?.height) || 0;
        const svgWidth = Number.parseFloat(svgElement.getAttribute('width')) || 0;
        const svgHeight = Number.parseFloat(svgElement.getAttribute('height')) || 0;
        const sourceWidth = viewBoxWidth || svgWidth || svgElement.getBoundingClientRect().width;
        const sourceHeight = viewBoxHeight || svgHeight || svgElement.getBoundingClientRect().height;
        const bars = [...svgElement.querySelectorAll('.bar')]
            .map(bar => {
                try {
                    return bar.getBBox();
                } catch {
                    return null;
                }
            })
            .filter(box => box && box.width > 0 && box.height > 0);
        const firstBarX = bars.length
            ? Math.min(...bars.map(box => box.x))
            : viewBoxX;
        const lastBarX = bars.length
            ? Math.max(...bars.map(box => box.x + box.width))
            : viewBoxX + sourceWidth;
        const cropPadding = 24;
        const cropX = Math.max(viewBoxX, firstBarX - cropPadding);
        const cropRight = Math.min(viewBoxX + sourceWidth, lastBarX + cropPadding);
        const cropWidth = Math.max(480, cropRight - cropX);
        const fullHeight = sourceHeight;

        wrapper.style.width = `${cropWidth + 80}px`;
        wrapper.style.minWidth = `${cropWidth + 80}px`;
        svgClone.setAttribute('width', String(cropWidth));
        if (fullHeight > 0) svgClone.setAttribute('height', String(fullHeight));
        svgClone.setAttribute('viewBox', `${cropX} ${viewBoxY} ${cropWidth} ${fullHeight}`);
        svgClone.style.width = `${cropWidth}px`;
        svgClone.style.maxWidth = 'none';
        svgClone.style.height = fullHeight > 0 ? `${fullHeight}px` : 'auto';
        svgClone.style.display = 'block';
        pdfContent.appendChild(svgClone);

        document.body.appendChild(wrapper);

        // ----- 2. Ждём отрисовку -----
        await new Promise(resolve => setTimeout(resolve, 400));

        // ----- 3. Рендерим через html2canvas -----
        const canvas = await html2canvas(wrapper, {
            scale: 2,
            useCORS: true,
            backgroundColor: '#ffffff',
            logging: false,
            windowWidth: Math.ceil(cropWidth + 80)
        });

        // ----- 4. Создаём PDF -----
        const { jsPDF } = window.jspdf;

        const pdf = new jsPDF({
            orientation: 'landscape',
            unit: 'mm',
            format: 'a4'
        });

        const pageWidth = pdf.internal.pageSize.getWidth();
        const pageHeight = pdf.internal.pageSize.getHeight();

        const pdfMargin = 12;
        const availableWidth = pageWidth - (pdfMargin * 2);
        const availableHeight = pageHeight - (pdfMargin * 2);
        const scale = Math.min(
            availableWidth / canvas.width,
            availableHeight / canvas.height
        );
        const imgWidth = canvas.width * scale;
        const imgHeight = canvas.height * scale;
        const imageX = (pageWidth - imgWidth) / 2;
        const imageY = (pageHeight - imgHeight) / 2;

        const imgData = canvas.toDataURL('image/png');

        pdf.addImage(imgData, 'PNG', imageX, imageY, imgWidth, imgHeight);

        // ----- 5. Скачиваем -----
        const safeName = project.name.replace(/[^a-zA-Z0-9а-яА-Я\s]/g, '').trim().replace(/\s+/g, '_');
        const fileName = `График_${safeName}_${new Date().toISOString().split('T')[0]}.pdf`;

        pdf.save(fileName);

        // ----- 6. Убираем временный контейнер -----
        document.body.removeChild(wrapper);

        log.info('✅ PDF сохранён:', fileName);
        toast('PDF скачан', 'success');

    } catch (err) {
        log.error('Ошибка генерации PDF:', err);
        toast('Ошибка генерации PDF: ' + err.message, 'error');
    }
}

// =====================================================================
// МОДАЛКА РЕДАКТИРОВАНИЯ ДАТ
// =====================================================================

export async function openEditDatesModal() {
    if (!canEditGantt()) {
        toast('Нет прав на редактирование графика', 'error');
        return;
    }

    const container = document.getElementById('edit-dates-content');
    if (!container) return;

    const project = window.__getCurrentProject?.();
    if (!project) {
        toast('Не удалось определить объект', 'error');
        return;
    }

    log.info(`Открываем редактор дат для объекта #${project.id} (${project.name})`);

    container.innerHTML = '<p class="text-center text-gray-400 py-3 text-sm">Загрузка разделов...</p>';
    showModal('edit-dates-modal');

    const { data: sections, error } = await db.select('sections', {
        filters: { project_id: project.id },
        orderBy: { column: 'id', asc: true }
    });

    if (error) {
        container.innerHTML = `<p class="text-center text-red-500 py-3 text-sm">Ошибка загрузки: ${error.message}</p>`;
        return;
    }

    // «Доп. расходы» — служебный раздел, у него нет плановых дат
    const planSections = (sections || []).filter(section => !isExtraSectionName(section.name));

    if (planSections.length === 0) {
        container.innerHTML = '<p class="text-center text-gray-400 py-3 text-sm">В этом объекте нет разделов. Их создаёт загрузка сметы (Администратор / Главный инженер / Инженер ПТО).</p>';
        return;
    }

    log.info(`Загружено ${planSections.length} разделов для объекта #${project.id}`);

    currentSections = planSections;

    container.innerHTML = planSections.map(s => `
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

    const project = window.__getCurrentProject?.();
    if (!project) {
        toast('Не удалось определить объект', 'error');
        return;
    }

    const rows = document.querySelectorAll('#edit-dates-content [data-section-id]');
    const updates = [];

    log.info(`Сохранение дат для объекта #${project.id} (${project.name}). Строк: ${rows.length}`);

    for (const row of rows) {
        const sectionId = parseInt(row.dataset.sectionId, 10);
        const start = row.querySelector('.section-start')?.value || null;
        const end = row.querySelector('.section-end')?.value || null;

        if ((start && !end) || (!start && end)) {
            toast(`Раздел #${sectionId}: укажи обе даты`, 'error');
            return;
        }

        if (start && end && start > end) {
            toast(`Раздел #${sectionId}: начало позже окончания`, 'error');
            return;
        }

        updates.push({ id: sectionId, planned_start_date: start, planned_end_date: end });
    }

    log.info(`Обновлений к сохранению: ${updates.length}`);

    let savedCount = 0;
    for (const upd of updates) {
        const { error } = await db.update('sections', {
            planned_start_date: upd.planned_start_date,
            planned_end_date: upd.planned_end_date
        }, { id: upd.id });

        if (!error) {
            savedCount++;
            log.db(`Обновлён раздел #${upd.id}`);
        } else {
            log.error(`Ошибка раздела #${upd.id}:`, error.message);
        }
    }

    toast(`Сохранено разделов: ${savedCount} из ${updates.length}`, 'success');
    hideModal('edit-dates-modal');

    if (project && window.renderGantt) {
        await window.renderGantt(project);
    }
}

// =====================================================================
// ЗАКРЫТИЕ РАЗДЕЛА (прораб)
// =====================================================================

export function openSectionDetailFromGantt(section) {
    const emp = getEmployee();
    if (!emp) return;

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

    const actionsContainer = document.getElementById('section-detail-gantt-actions');
    if (actionsContainer) {
        let actionsHtml = '';

        if (!section.actual_end_date && can('close_section')) {
            const currentProject = window.__getCurrentProject?.();
            if (currentProject && currentProject.foreman_id === emp.id) {
                actionsHtml += `<button data-action="openCloseSectionModal" data-arg="${section.id}" 
                                class="bg-[#15803d] hover:bg-[#166534] text-white font-semibold px-4 py-2 rounded-lg text-sm transition">
                                ✅ Отметить выполненным
                                </button>`;
            }
        }

        if (section.actual_end_date && canEditGantt()) {
            actionsHtml += `<button data-action="uncloseSection" data-arg="${section.id}" 
                            class="bg-amber-500 hover:bg-amber-600 text-white font-semibold px-4 py-2 rounded-lg text-sm transition">
                            ↩️ Снять отметку выполнения
                            </button>`;
        }

        actionsContainer.innerHTML = actionsHtml;
    }

    showModal('section-detail-gantt-modal');
}

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

    if (window.__getCurrentProject) {
        const project = window.__getCurrentProject();
        if (project) await renderGantt(project);
    }
}

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

export function getSectionStatusInfo(section) {
    if (section.actual_end_date) {
        const actual = new Date(section.actual_end_date).getTime();
        const planned = section.planned_end_date ? new Date(section.planned_end_date).getTime() : null;

        if (planned && actual <= planned) {
            return { label: '🟢 Выполнено в срок', bg: 'bg-green-100', color: 'text-green-700' };
        } else {
            return { label: '🔴 Выполнено с опозданием', bg: 'bg-red-100', color: 'text-red-700' };
        }
    }

    if (section.planned_end_date) {
        const today = new Date().getTime();
        const planned = new Date(section.planned_end_date).getTime();
        if (today > planned) {
            return { label: '⚠️ Просрочено', bg: 'bg-amber-100', color: 'text-amber-800' };
        }
    }

    if (!section.planned_start_date || !section.planned_end_date) {
        return { label: '⚪ Даты не заданы', bg: 'bg-gray-100', color: 'text-gray-600' };
    }

    return { label: '🔵 В плане', bg: 'bg-blue-100', color: 'text-blue-700' };
}

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
window.downloadGanttPDF = downloadGanttPDF;