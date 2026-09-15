// =====================================================================
// МОДУЛЬ: ОБЪЕКТЫ (проекты)
// =====================================================================
// Управление строительными объектами.
//
// Связи:
//   - foreman_id → employees.id (прораб объекта)
//
// Права:
//   - Администратор: создаёт/редактирует/удаляет, видит все
//   - Директор, Гл. инженер, Снабженец, Инженер ПТО: видят все
//   - Прораб: видит только свои объекты
// =====================================================================

import { db } from '../database.js';
import {
    log, toast, escapeHtml, showModal, hideModal,
    formatDate, formatMoney
} from '../utils.js';
import {
    can, requirePermission, getEmployee, isAdmin
} from '../permissions.js';
import {
    renderEstimateUI,
    renderSectionsUI,
    loadSections
} from './estimate.js';
import { loadExpensesForProject } from './cash.js';
import { renderGantt } from './gantt.js';
import { renderProjectFiles } from './files.js';

// =====================================================================
// СОСТОЯНИЕ
// =====================================================================

let projectsCache = [];
let employeesCache = [];
let currentActiveProjId = null;
let currentSectionsCache = [];

// =====================================================================
// ЗАГРУЗКА
// =====================================================================

export async function loadProjects() {
    log.info('Загрузка объектов...');

    let filters = null;

    if (!can('view_projects_all')) {
        const emp = getEmployee();
        if (emp) {
            filters = { foreman_id: emp.id };
            log.info(`Фильтр: только объекты прораба #${emp.id}`);
        } else {
            projectsCache = [];
            renderProjects();
            updateProjectsBadge();
            return;
        }
    }

    const { data, error } = await db.select('projects', {
        select: `
            *,
            foreman:employees (
                id, name, position, phone, status
            )
        `,
        filters,
        orderBy: { column: 'created_at', asc: false }
    });

    if (error) {
        log.error('Ошибка загрузки объектов:', error.message);
        toast('Не удалось загрузить объекты', 'error');
        return;
    }

    projectsCache = data || [];
    log.info(`Загружено объектов: ${projectsCache.length}`);
    renderProjects();
    updateProjectsBadge();
}

async function loadActiveEmployees() {
    const { data, error } = await db.select('employees', {
        filters: { status: 'active' },
        orderBy: { column: 'name', asc: true }
    });

    if (error) {
        log.error('Ошибка загрузки сотрудников:', error.message);
        return [];
    }

    employeesCache = data || [];
    return employeesCache;
}

// =====================================================================
// СПИСОК ОБЪЕКТОВ
// =====================================================================

export function renderProjects() {
    const container = document.getElementById('projects-container');
    if (!container) return;

    const addBtn = document.getElementById('add-project-btn');
    if (addBtn) {
        addBtn.style.display = can('add_project') ? '' : 'none';
    }

    if (projectsCache.length === 0) {
        container.innerHTML = `
            <div class="col-span-2 bg-white rounded-xl shadow-sm border-2 border-dashed border-gray-300 p-8 text-center space-y-2">
                <div class="text-5xl">🏗</div>
                <h3 class="font-bold text-gray-700">Объектов пока нет</h3>
                <p class="text-sm text-gray-500">
                    ${can('add_project') ? 'Нажми «➕ Добавить объект», чтобы создать первый' : 'Обратитесь к администратору'}
                </p>
            </div>
        `;
        return;
    }

    container.innerHTML = projectsCache.map(p => renderProjectCard(p)).join('');
}

function renderProjectCard(project) {
    const foreman = project.foreman;
    const foremanName = foreman?.name || '— не назначен —';
    const foremanPhone = foreman?.phone || '';
    const foremanBlocked = foreman?.status === 'blocked';

    const hasEstimate = !!project.estimate_file_path;
    const estimateLabel = hasEstimate
        ? `<span class="text-[10px] text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded font-semibold">📊 Смета загружена</span>`
        : `<span class="text-[10px] text-gray-400 bg-gray-50 px-2 py-0.5 rounded">📊 Сметы нет</span>`;

    return `
        <button onclick="window.openProjectDetail(${project.id})"
                class="w-full text-left bg-white rounded-xl shadow-sm border p-4 flex flex-col gap-3 border-l-4 border-[#15803d] hover:bg-emerald-50/50 transition cursor-pointer group">
            <div class="flex justify-between items-start gap-2 w-full">
                <h3 class="font-bold text-[#166534] text-base group-hover:underline">🏗 ${escapeHtml(project.name)}</h3>
                <span class="text-xs text-[#15803d] bg-emerald-100 px-2 py-0.5 rounded font-semibold whitespace-nowrap">Открыть →</span>
            </div>
            
            <div class="space-y-1">
                <p class="text-xs text-gray-600">
                    <strong>👨‍💼 Прораб:</strong> 
                    <span class="${foremanBlocked ? 'text-red-600 line-through' : 'text-gray-900 font-semibold'}">${escapeHtml(foremanName)}</span>
                    ${foremanBlocked ? `<span class="text-[10px] text-red-600 font-semibold ml-1">(заблокирован)</span>` : ''}
                </p>
                ${foremanPhone ? `<p class="text-xs text-gray-600"><strong>📞</strong> <span class="text-[#15803d] font-semibold">${escapeHtml(foremanPhone)}</span></p>` : ''}
            </div>

            <div class="flex justify-between items-center pt-1 border-t">
                ${estimateLabel}
                <span class="text-[10px] text-gray-400">📅 ${formatDate(project.created_at)}</span>
            </div>
        </button>
    `;
}

// =====================================================================
// КАРТОЧКА ОБЪЕКТА
// =====================================================================

export async function openProjectDetail(id) {
    let project = projectsCache.find(p => String(p.id) === String(id));
    if (!project) {
        const { data, error } = await db.select('projects', { filters: { id } });
        if (error || !data?.[0]) {
            toast('Объект не найден', 'error');
            return;
        }
        project = data[0];
        projectsCache.push(project);
    }
    if (!project) {
        toast('Объект не найден', 'error');
        return;
    }

    currentActiveProjId = id;

    const titleEl = document.getElementById('card-proj-title');
    if (titleEl) titleEl.textContent = `🏗 ${project.name}`;

    // 1. Загружаем разделы объекта (кэш)
    const { data: sections } = await loadSections(project.id);
    currentSectionsCache = sections || [];

    // 2. ОДИН запрос — все расходы объекта (map: { [section_id]: [ops] })
    const { map: expensesMap } = await loadExpensesForProject(project.id);

    // 3. Рендерим общую информацию (передаём готовые расходы)
    renderProjectInfo(project, expensesMap);

    // 4. Рендерим вкладку «Файлы»
    renderEstimateUI(project);
    renderProjectFiles(project);

    // 5. Рендерим «План-факт» (передаём и расходы, и разделы)
    renderSectionsUI(project, expensesMap, currentSectionsCache);

    // 6. Кнопка удаления
    const deleteBtn = document.getElementById('card-proj-delete-btn');
    if (deleteBtn) {
        if (can('delete_project')) {
            deleteBtn.style.display = '';
            deleteBtn.onclick = () => confirmDeleteProject(project.id, project.name);
        } else {
            deleteBtn.style.display = 'none';
        }
    }

    // 7. Показываем карточку
    const detailEl = document.getElementById('tab-project-detail');
    if (detailEl) {
        ['welcome', 'projects', 'employees', 'tasks', 'orders', 'registry', 'new-order'].forEach(t => {
            const el = document.getElementById(`tab-${t}`);
            if (el) el.classList.add('hidden');
        });
        detailEl.classList.remove('hidden');
    }

    switchProjectSubTab('info');
}

/**
 * Считает план по разделам.
 */
function calcPlan(sections) {
    let works = 0;
    let materials = 0;
    let total = 0;

    (sections || []).forEach(s => {
        works += Number(s.plan_works) || 0;
        materials += Number(s.plan_materials) || 0;
        total += Number(s.plan_total) || 0;
    });

    return { works, materials, total };
}

/**
 * Считает факт по всем разделам из map.
 * materials = materials + delivery
 * works = works
 */
function calcFact(expensesMap) {
    let works = 0;
    let materials = 0;
    let total = 0;

    Object.values(expensesMap || {}).forEach(ops => {
        (ops || []).forEach(op => {
            const amount = Number(op.amount) || 0;
            total += amount;

            if (op.category === 'works') {
                works += amount;
            } else if (op.category === 'materials' || op.category === 'delivery') {
                materials += amount;
            }
        });
    });

    return { works, materials, total };
}

function renderProjectInfo(project, expensesMap = {}) {
    const container = document.getElementById('proj-subtab-info');
    if (!container) return;

    const foreman = project.foreman;
    const foremanName = foreman?.name || 'Не назначен';
    const foremanPhone = foreman?.phone || '';
    const foremanPosition = foreman?.position || '—';

    const plan = calcPlan(currentSectionsCache);
    const fact = calcFact(expensesMap);

    const balanceWorks = plan.works - fact.works;
    const balanceMaterials = plan.materials - fact.materials;
    const balanceTotal = plan.total - fact.total;

    const isOverWorks = fact.works > plan.works;
    const isOverMaterials = fact.materials > plan.materials;
    const isOverTotal = fact.total > plan.total;

    const colorFactWorks = isOverWorks ? 'text-red-600' : 'text-emerald-700';
    const colorFactMaterials = isOverMaterials ? 'text-red-600' : 'text-emerald-700';
    const colorFactTotal = isOverTotal ? 'text-red-600' : 'text-emerald-700';

    const colorBalanceWorks = balanceWorks >= 0 ? 'text-emerald-700' : 'text-red-600';
    const colorBalanceMaterials = balanceMaterials >= 0 ? 'text-emerald-700' : 'text-red-600';
    const colorBalanceTotal = balanceTotal >= 0 ? 'text-emerald-700' : 'text-red-600';

    const hasSections = currentSectionsCache.length > 0;

    container.innerHTML = `
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <!-- Прораб -->
            <div class="bg-white border border-gray-200 rounded-xl p-4 shadow-sm">
                <h5 class="text-[#15803d] font-bold mb-3 flex items-center text-sm">
                    <span class="mr-2 text-base">👨‍💼</span> Материально ответственное лицо
                </h5>
                <p class="mb-1 text-xs sm:text-sm"><strong>Должность:</strong> <span class="text-gray-900 font-semibold">${escapeHtml(foremanPosition)}</span></p>
                <p class="mb-1 text-xs sm:text-sm"><strong>ФИО:</strong> <span class="text-gray-900 font-semibold">${escapeHtml(foremanName)}</span></p>
                <p class="mb-0 text-xs sm:text-sm">
                    <strong>Телефон:</strong> 
                    ${foremanPhone ? `<a href="tel:${escapeHtml(foremanPhone)}" class="text-[#15803d] hover:underline font-semibold">${escapeHtml(foremanPhone)}</a>` : '—'}
                </p>
            </div>

            <!-- Финансовая таблица -->
            <div class="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
                <div class="bg-emerald-600 text-white font-bold px-3 py-2 flex justify-between items-center text-sm">
                    <span>📊 Финансы по объекту</span>
                    ${isOverTotal 
                        ? `<span class="bg-red-500 px-2 py-0.5 rounded text-[11px]">⚠️ Перерасход</span>` 
                        : (hasSections ? `<span class="bg-emerald-700 px-2 py-0.5 rounded text-[11px]">✔ В норме</span>` : `<span class="bg-emerald-700 px-2 py-0.5 rounded text-[11px]">Сметы нет</span>`)}
                </div>
                <table class="w-full text-xs">
                    <thead class="bg-gray-100 text-gray-600 uppercase text-[10px]">
                        <tr>
                            <th class="p-2 text-left">Категория</th>
                            <th class="p-2 text-right">План</th>
                            <th class="p-2 text-right">Факт</th>
                            <th class="p-2 text-right">Остаток</th>
                        </tr>
                    </thead>
                    <tbody class="divide-y">
                        <tr>
                            <td class="p-2 text-gray-700">🛠 Работы</td>
                            <td class="p-2 text-right font-semibold text-gray-800">${formatMoney(plan.works)}</td>
                            <td class="p-2 text-right font-semibold ${colorFactWorks}">${formatMoney(fact.works)}</td>
                            <td class="p-2 text-right font-bold ${colorBalanceWorks}">${formatMoney(Math.abs(balanceWorks))}</td>
                        </tr>
                        <tr>
                            <td class="p-2 text-gray-700">📦 Материалы</td>
                            <td class="p-2 text-right font-semibold text-gray-800">${formatMoney(plan.materials)}</td>
                            <td class="p-2 text-right font-semibold ${colorFactMaterials}">${formatMoney(fact.materials)}</td>
                            <td class="p-2 text-right font-bold ${colorBalanceMaterials}">${formatMoney(Math.abs(balanceMaterials))}</td>
                        </tr>
                        <tr class="bg-emerald-50">
                            <td class="p-2 font-bold text-[#166534]">💰 ИТОГО</td>
                            <td class="p-2 text-right font-bold text-[#166534]">${formatMoney(plan.total)}</td>
                            <td class="p-2 text-right font-bold ${colorFactTotal}">${formatMoney(fact.total)}</td>
                            <td class="p-2 text-right font-bold ${colorBalanceTotal}">${formatMoney(Math.abs(balanceTotal))}</td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>
    `;
}

// =====================================================================
// ПОДВКЛАДКИ
// =====================================================================

export function switchProjectSubTab(subId) {
    ['info', 'planfact', 'files', 'schedule'].forEach(s => {
        const el = document.getElementById(`proj-subtab-${s}`);
        const btn = document.getElementById(`subbtn-${s}`);
        if (el) el.classList.add('hidden');
        if (btn) {
            btn.className = "px-3.5 py-2 bg-gray-200 text-gray-700 hover:bg-gray-300 rounded-lg text-xs font-semibold transition shadow";
        }
    });

    const targetEl = document.getElementById(`proj-subtab-${subId}`);
    const targetBtn = document.getElementById(`subbtn-${subId}`);
    if (targetEl) targetEl.classList.remove('hidden');
    if (targetBtn) {
        targetBtn.className = "px-3.5 py-2 bg-[#15803d] text-white rounded-lg text-xs font-semibold transition shadow";
    }

    // Триггер для графика              ← НОВЫЙ БЛОК
    if (subId === 'schedule') {
        const project = getCurrentProject();
        if (project) {
            setTimeout(() => {
                renderGantt(project);
            }, 100);
        }
    }
}

// =====================================================================
// СОЗДАНИЕ
// =====================================================================

export async function openAddProjectModal() {
    if (!requirePermission('add_project')) return;

    const employees = await loadActiveEmployees();

    if (employees.length === 0) {
        toast('Нет активных сотрудников. Сначала добавь прораба.', 'warning');
        return;
    }

    const foremanSelect = document.getElementById('new-proj-foreman');
    if (foremanSelect) {
        foremanSelect.innerHTML = employees
            .map(e => `<option value="${e.id}">${escapeHtml(e.name)} (${escapeHtml(e.position)})</option>`)
            .join('');
    }

    document.getElementById('new-proj-name').value = '';
    showModal('project-modal');
}

export async function saveNewProject(event) {
    event.preventDefault();
    if (!requirePermission('add_project')) return;

    const form = event.target;
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Сохраняем...';

    const name = document.getElementById('new-proj-name').value.trim();
    const foremanId = parseInt(document.getElementById('new-proj-foreman').value, 10);

    if (!name || !foremanId) {
        toast('Заполни все поля', 'error');
        submitBtn.disabled = false;
        submitBtn.textContent = '💾 Сохранить';
        return;
    }

    const { error } = await db.insert('projects', {
        name,
        foreman_id: foremanId
    });

    submitBtn.disabled = false;
    submitBtn.textContent = '💾 Сохранить';

    if (error) {
        log.error('Ошибка создания объекта:', error.message);
        toast('Не удалось сохранить: ' + error.message, 'error');
        return;
    }

    toast(`Объект «${name}» создан`, 'success');
    hideModal('project-modal');
    form.reset();
    await loadProjects();
}

// =====================================================================
// УДАЛЕНИЕ
// =====================================================================

async function confirmDeleteProject(id, name) {
    if (!requirePermission('delete_project')) return;

    if (!confirm(`УДАЛИТЬ объект "${name}"?\n\n⚠️ Все данные объекта (заявки, задачи) будут удалены.`)) return;

    const { error } = await db.remove('projects', { id });

    if (error) {
        toast('Ошибка удаления: ' + error.message, 'error');
        return;
    }

    toast('Объект удалён', 'success');

    if (window.switchTab) window.switchTab('projects');
    await loadProjects();
}

// =====================================================================
// БЕЙДЖ
// =====================================================================

export function updateProjectsBadge() {
    const badge = document.getElementById('projects-badge');
    if (badge) badge.textContent = projectsCache.length;
}

// =====================================================================
// ЭКСПОРТ ДЛЯ ДРУГИХ МОДУЛЕЙ
// =====================================================================

export function getCurrentProject() {
    return projectsCache.find(p => p.id === currentActiveProjId) || null;
}

export function getSectionsCache() {
    return currentSectionsCache;
}

// =====================================================================
// ГЛОБАЛЬНЫЕ ФУНКЦИИ
// =====================================================================

window.openProjectDetail = openProjectDetail;
window.openAddProjectModal = openAddProjectModal;
window.saveNewProject = saveNewProject;
window.switchProjectSubTab = switchProjectSubTab;
window.__getCurrentProject = getCurrentProject;
window.__getSectionsCache = getSectionsCache;