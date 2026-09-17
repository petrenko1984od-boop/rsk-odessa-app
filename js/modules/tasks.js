// =====================================================================
// МОДУЛЬ: ЗАДАЧИ ПРОРАБУ
// =====================================================================
// Постановщик (Админ/Директор/Гл. инженер/Инженер ПТО) ставит задачу.
// Исполнитель (Прораб/Снабженец/Инженер ПТО) выполняет.
//
// Статусы:
//   pending     — 🟡 Новая
//   in_progress — 🔵 В работе
//   done        — 🟢 Выполнена
//   cancelled   — ⚫ Отменена
//
// Права:
//   - Создание: Админ / Директор / Гл. инженер / Инженер ПТО
//   - Просмотр: все (автор — все, исполнитель — свои)
//   - Обработка: исполнитель (взять в работу, выполнить) + автор (отменить)
// =====================================================================

import { db } from '../database.js';
import {
    log, toast, escapeHtml, showModal, hideModal,
    formatDate, formatMoney, parseNumber
} from '../utils.js';
import { can, getEmployee } from '../permissions.js';
import { CONFIG } from '../config.js';

// =====================================================================
// СОСТОЯНИЕ
// =====================================================================

let tasksCache = [];
let currentFilter = 'active';   // 'active' | 'pending' | 'in_progress' | 'done' | 'all'
let currentTaskId = null;

// =====================================================================
// ПРАВА
// =====================================================================

/**
 * Может ли текущий пользователь создавать задачи?
 */
export function canCreateTask() {
    return can('create_task');
}

/**
 * Может ли текущий пользователь быть исполнителем задачи?
 */
export function canBeAssignee() {
    return can('become_task_assignee');
}

/**
 * Может ли текущий пользователь отменить задачу?
 * Только автор или Администратор.
 */
function canCancelTask(task) {
    const emp = getEmployee();
    if (!emp) return false;
    if (can('cancel_any_task')) return true;
    return task.author_employee_id === emp.id;
}

/**
 * Может ли текущий пользователь выполнить задачу?
 * Только назначенный исполнитель.
 */
function canCompleteTask(task) {
    const emp = getEmployee();
    if (!emp) return false;
    return task.assignee_employee_id === emp.id;
}

/**
 * Видит ли текущий пользователь эту задачу?
 * - Админ/Директор — все (право view_all_tasks).
 * - Автор — свои (что поставил).
 * - Исполнитель — свои (что назначены).
 */
function canSeeTask(task) {
    const emp = getEmployee();
    if (!emp) return false;

    if (can('view_all_tasks')) return true;
    if (task.author_employee_id === emp.id) return true;
    if (task.assignee_employee_id === emp.id) return true;

    return false;
}

// =====================================================================
// ЗАГРУЗКА
// =====================================================================

export async function loadTasks() {
    log.info('Загрузка задач...');

    const tasksContainer = document.getElementById('tasks-container');
    if (tasksContainer) {
        tasksContainer.innerHTML = '<div class="app-loading app-loading-card text-sm"><span class="app-spinner" aria-hidden="true"></span><span>Загрузка задач...</span></div>';
    }

    const { data, error } = await db.select('tasks', {
        select: `
            *,
            project:projects ( id, name ),
            section:sections ( id, name ),
            author:employees!tasks_author_employee_id_fkey ( id, name, position ),
            assignee:employees!tasks_assignee_employee_id_fkey ( id, name, position )
        `,
        orderBy: { column: 'created_at', asc: false }
    });

    if (error) {
        log.error('Ошибка загрузки задач:', error.message);
        toast('Не удалось загрузить задачи', 'error');
        return;
    }

    // Фильтруем по правам
    const all = data || [];
    tasksCache = all.filter(canSeeTask);

    log.info(`Загружено задач: ${tasksCache.length}`);
    renderTasks();
    updateTasksBadge();
}

// =====================================================================
// ФИЛЬТРАЦИЯ
// =====================================================================

function getFilteredTasks() {
    if (currentFilter === 'all') return tasksCache;

    if (currentFilter === 'active') {
        return tasksCache.filter(t => 
            t.status === 'pending' || t.status === 'in_progress'
        );
    }

    if (currentFilter === 'overdue') {
        return tasksCache.filter(t => {
            if (!t.deadline || t.status === 'done' || t.status === 'cancelled') return false;
            const deadline = new Date(`${t.deadline}T23:59:59`);
            return !Number.isNaN(deadline.getTime()) && deadline < new Date();
        });
    }

    if (currentFilter === 'done_30') {
        return tasksCache.filter(t => {
            if (t.status !== 'done' || !t.completed_at) return false;
            const completed = new Date(t.completed_at);
            const cutoff = new Date();
            cutoff.setDate(cutoff.getDate() - 30);
            return !Number.isNaN(completed.getTime()) && completed >= cutoff;
        });
    }

    return tasksCache.filter(t => t.status === currentFilter);
}

export function switchTasksTab(filter) {
    currentFilter = filter;

    const filters = ['active', 'pending', 'in_progress', 'done', 'all', 'overdue', 'done_30'];
    filters.forEach(f => {
        const btn = document.getElementById(`tasks-filter-${f}`);
        if (!btn) return;
        if (f === filter) {
            btn.classList.remove('bg-gray-100', 'text-gray-600', 'hover:bg-gray-200');
            btn.classList.add('bg-[#15803d]', 'text-white');
        } else {
            btn.classList.add('bg-gray-100', 'text-gray-600', 'hover:bg-gray-200');
            btn.classList.remove('bg-[#15803d]', 'text-white');
        }
    });

    renderTasks();
}

export async function openTaskFilterModal(filter) {
    currentFilter = filter;

    await loadTasks();

    const labels = {
        active: 'Активные задачи',
        pending: 'Новые задачи',
        in_progress: 'Задачи в работе',
        done: 'Выполненные задачи',
        all: 'Все задачи',
        overdue: 'Просроченные задачи',
        done_30: 'Выполненные за 30 дней'
    };
    const accents = {
        active: 'text-amber-700',
        overdue: 'text-red-700',
        done_30: 'text-emerald-700',
        all: 'text-gray-800'
    };

    const filtered = getFilteredTasks();
    const modalTitle = document.getElementById('task-filter-title');
    const titlePrefix = labels[filter] || 'Задачи';
    if (modalTitle) {
        modalTitle.textContent = `${titlePrefix} (${filtered.length})`;
        modalTitle.className = `text-lg font-bold ${accents[filter] || accents.all}`;
    }
    const container = document.getElementById('task-filter-content');
    if (!container) return;

    if (filtered.length === 0) {
        container.innerHTML = `
            <div class="rounded-xl border-2 border-dashed border-gray-300 bg-gray-50 p-8 text-center">
                <div class="text-4xl">📋</div>
                <p class="mt-3 text-sm text-gray-500">Нет задач по выбранному фильтру.</p>
            </div>
        `;
        showModal('task-filter-modal');
        return;
    }

    container.innerHTML = `
        <div class="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
            <table class="min-w-[920px] w-full border-collapse text-sm text-gray-800">
                <thead class="bg-gray-50 text-left text-[11px] font-bold uppercase tracking-wide text-gray-600">
                    <tr>
                        <th class="border-b border-gray-200 px-3 py-2">Приоритет</th>
                        <th class="border-b border-gray-200 px-3 py-2">Заголовок</th>
                        <th class="border-b border-gray-200 px-3 py-2">Объект</th>
                        <th class="border-b border-gray-200 px-3 py-2">Исполнитель</th>
                        <th class="border-b border-gray-200 px-3 py-2">Дедлайн</th>
                        <th class="border-b border-gray-200 px-3 py-2">Статус</th>
                        <th class="border-b border-gray-200 px-3 py-2">Автор</th>
                    </tr>
                </thead>
                <tbody>
                    ${filtered.map(task => {
                        const statusInfo = getTaskStatusInfo(task.status);
                        const projectName = task.project?.name || 'Без объекта';
                        const assigneeName = task.assignee?.name || '—';
                        const deadline = task.deadline ? formatDate(task.deadline) : '—';
                        const isOverdue = isOverdueTask(task);
                        const priorityInfo = getTaskPriorityInfo(task.priority);
                        const title = task.title || task.text || '—';

                        return `
                            <tr onclick="window.openTaskDetail(${task.id}); window.hideModal('task-filter-modal');"
                                class="cursor-pointer border-b border-gray-200 last:border-0 transition hover:bg-emerald-50/60">
                                <td class="w-[12%] px-3 py-3 align-top"><span class="inline-flex rounded-full px-2 py-1 text-[10px] font-bold ${priorityInfo.bg} ${priorityInfo.color}">${priorityInfo.label}</span></td>
                                <td class="w-[24%] px-3 py-3 align-top font-semibold text-gray-800">${escapeHtml(title)}</td>
                                <td class="w-[18%] px-3 py-3 align-top text-gray-600">${escapeHtml(projectName)}</td>
                                <td class="w-[18%] px-3 py-3 align-top text-gray-600">${escapeHtml(assigneeName)}</td>
                                <td class="w-[14%] px-3 py-3 align-top ${isOverdue ? 'font-bold text-red-600' : 'text-gray-600'}">${deadline}</td>
                                <td class="w-[12%] px-3 py-3 align-top">
                                    <span class="inline-flex rounded-full px-2 py-1 text-[10px] font-bold ${statusInfo.bg} ${statusInfo.color}">${statusInfo.label}</span>
                                </td>
                            </tr>
                        `;
                    }).join('')}
                </tbody>
            </table>
        </div>
    `;

    showModal('task-filter-modal');
}

// =====================================================================
// РЕНДЕР СПИСКА
// =====================================================================

export function renderTasks() {
    const container = document.getElementById('tasks-container');
    if (!container) return;

    const filtered = getFilteredTasks();

    // Показать/скрыть кнопку создания
    const createBtn = document.getElementById('create-task-btn');
    if (createBtn) {
        createBtn.style.display = canCreateTask() ? '' : 'none';
    }

    if (filtered.length === 0) {
        container.innerHTML = `
            <div class="bg-white rounded-xl shadow-sm border-2 border-dashed border-gray-300 p-8 text-center space-y-2">
                <div class="text-5xl">📋</div>
                <h3 class="font-bold text-gray-700">Задач нет</h3>
                <p class="text-sm text-gray-500">
                    ${canCreateTask() ? 'Нажми «➕ Создать задачу»' : 'Пока задач нет'}
                </p>
            </div>
        `;
        return;
    }

    container.innerHTML = filtered.map(renderTaskCard).join('');
}

function renderTaskCard(task) {
    const statusInfo = getTaskStatusInfo(task.status);
    const priorityInfo = getTaskPriorityInfo(task.priority);

    const projectName = task.project?.name || 'Без объекта';
    const assigneeName = task.assignee?.name || '—';
    const authorName = task.author?.name || '—';

    // Проверка дедлайна
    const today = new Date().toISOString().split('T')[0];
    const isOverdue = task.deadline 
        && task.deadline < today 
        && task.status !== 'done' 
        && task.status !== 'cancelled';

    // Индикатор фотоотчёта
    const hasPhoto = !!task.photo_path;

    return `
        <button onclick="window.openTaskDetail(${task.id})"
            class="flex min-h-[184px] w-full cursor-pointer flex-col gap-3 rounded-xl border border-gray-200 border-l-4 bg-white p-4 text-left shadow-sm transition hover:bg-emerald-50/50 group ${isOverdue ? 'border-l-red-500' : statusInfo.border.replace('border-', 'border-l-')} ">
            <div class="flex justify-between items-start gap-2 w-full">
                <div class="flex items-center gap-2 flex-wrap">
                    <span class="text-xs font-bold px-2 py-0.5 rounded ${priorityInfo.bg} ${priorityInfo.color}">${priorityInfo.label}</span>
                    <span class="text-xs font-bold px-2 py-0.5 rounded ${statusInfo.bg} ${statusInfo.color}">${statusInfo.label}</span>
                    ${isOverdue ? `<span class="text-[10px] bg-red-100 text-red-700 px-2 py-0.5 rounded font-bold">⚠️ Просрочено</span>` : ''}
                    ${hasPhoto ? `<span class="text-[10px] bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded font-bold">📸 Фото</span>` : ''}
                </div>
            </div>

            <h3 class="font-bold text-[#166534] text-base group-hover:underline">${escapeHtml(task.title || task.text || '—')}</h3>

            ${task.description ? `<p class="text-xs text-gray-600 line-clamp-2">${escapeHtml(task.description)}</p>` : ''}

            <div class="space-y-1">
                <p class="text-xs text-gray-600"><strong>🏗 Объект:</strong> ${escapeHtml(projectName)}</p>
                <p class="text-xs text-gray-600"><strong>👤 Исполнитель:</strong> <span class="text-gray-900 font-semibold">${escapeHtml(assigneeName)}</span></p>
                ${task.deadline ? `<p class="text-xs ${isOverdue ? 'text-red-600 font-bold' : 'text-gray-600'}"><strong>📅 Дедлайн:</strong> ${formatDate(task.deadline)}</p>` : ''}
            </div>

            <div class="flex justify-between items-center pt-1 border-t text-[10px] text-gray-400">
                <span>👤 Поставил: ${escapeHtml(authorName)}</span>
                <span>📅 ${formatDate(task.created_at)}</span>
            </div>
        </button>
    `;
}

// =====================================================================
// КАРТОЧКА ЗАДАЧИ (просмотр)
// =====================================================================

export async function openTaskDetail(id) {
    const task = tasksCache.find(t => t.id === id);
    if (!task) {
        toast('Задача не найдена', 'error');
        return;
    }

    currentTaskId = id;

    const statusInfo = getTaskStatusInfo(task.status);
    const priorityInfo = getTaskPriorityInfo(task.priority);

    const projectName = task.project?.name || '—';
    const sectionName = task.section?.name || '—';
    const assigneeName = task.assignee?.name || '—';
    const authorName = task.author?.name || '—';

    const completionComment = Array.isArray(task.history)
        ? [...task.history].reverse().find(item => item.action === 'Задача выполнена' && item.comment)
        : null;

    const completionBlock = completionComment && completionComment.comment
        ? `
            <div class="bg-green-50 border border-green-200 rounded-lg p-3 space-y-1">
                <p class="text-[10px] font-bold uppercase tracking-wider text-green-700">✅ Результат выполнения</p>
                <p class="text-sm text-gray-700 whitespace-pre-line">${escapeHtml(completionComment.comment)}</p>
                <p class="text-[10px] text-gray-500">👤 ${escapeHtml(completionComment.author || '—')} · 📅 ${formatDate(completionComment.date)}</p>
            </div>
        `
        : '';

    // Фотоотчёт
    const photoHtml = task.photo_path
        ? `<div class="bg-emerald-50 border border-emerald-200 rounded-lg p-3 flex items-center justify-between">
              <span class="text-xs text-emerald-800 font-semibold">📸 Фотоотчёт прикреплён</span>
              <button onclick="window.viewTaskPhoto('${escapeHtml(task.photo_path)}')" 
                      class="text-xs bg-emerald-100 hover:bg-emerald-200 text-[#15803d] px-3 py-1 rounded font-semibold transition">Посмотреть</button>
           </div>`
        : '';

    // Комментарии (хранятся в tasks.comments как JSONB-массив)
    const comments = Array.isArray(task.comments) ? task.comments : [];
    const commentsBlock = `
        <div class="space-y-2 rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs">
            <p class="font-bold text-gray-500 uppercase tracking-wider">💬 Комментарии (${comments.length})</p>
            ${comments.length === 0
                ? '<p class="text-gray-400 italic">Комментариев пока нет</p>'
                : comments.map(comment => `
                    <div class="bg-white border border-gray-200 rounded-lg p-2 space-y-0.5">
                        <p class="text-gray-700 whitespace-pre-line">${escapeHtml(comment.text || '')}</p>
                        <p class="text-[10px] text-gray-500">👤 ${escapeHtml(comment.author || '—')} · 📅 ${formatDate(comment.date)}</p>
                    </div>
                `).join('')}
            <div class="flex gap-2 pt-1">
                <input type="text" id="task-comment-input" maxlength="1000" placeholder="Написать комментарий..."
                       class="flex-1 border rounded-lg p-2 text-xs text-gray-800 outline-none focus:ring-2 focus:ring-[#15803d]">
                <button type="button" onclick="window.addTaskComment(${task.id})"
                        class="bg-[#15803d] hover:bg-[#166534] text-white font-semibold px-3 py-2 rounded-lg text-xs transition">Отправить</button>
            </div>
        </div>
    `;

    const container = document.getElementById('task-detail-content');
    if (!container) return;

    container.innerHTML = `
        <div class="flex flex-wrap justify-between items-center gap-2 bg-emerald-50 p-3 rounded-lg border border-emerald-200">
            <div class="flex items-center gap-2 flex-wrap">
                <span class="text-xs font-bold px-2 py-0.5 rounded ${priorityInfo.bg} ${priorityInfo.color}">${priorityInfo.label}</span>
                <span class="text-xs font-bold px-2 py-0.5 rounded ${statusInfo.bg} ${statusInfo.color}">${statusInfo.label}</span>
            </div>
            ${task.deadline ? `<span class="text-xs text-gray-600">📅 ${formatDate(task.deadline)}</span>` : ''}
        </div>

        <h3 class="text-lg font-bold text-[#166534]">${escapeHtml(task.title || task.text || '—')}</h3>

        ${task.description ? `
            <div class="rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs">
                <p class="font-bold text-gray-500 uppercase tracking-wider mb-1">📝 Описание:</p>
                <p class="text-gray-700 whitespace-pre-line">${escapeHtml(task.description)}</p>
            </div>
        ` : ''}

        <div class="space-y-2 rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs">
            <p><strong>🏗 Объект:</strong> <span class="font-semibold text-gray-800">${escapeHtml(projectName)}</span></p>
            ${task.section_id ? `<p><strong>📂 Раздел:</strong> <span class="font-semibold text-gray-800">${escapeHtml(sectionName)}</span></p>` : ''}
            <p><strong>👤 Исполнитель:</strong> ${escapeHtml(assigneeName)}</p>
            <p><strong>👤 Поставил:</strong> ${escapeHtml(authorName)}</p>
            <p><strong>📅 Создано:</strong> ${formatDate(task.created_at)}</p>
            ${task.completed_at ? `<p><strong>✅ Выполнено:</strong> ${formatDate(task.completed_at)}</p>` : ''}
        </div>

        ${photoHtml}

        ${completionBlock}

        ${commentsBlock}
    `;

    // Отправка комментария по Enter
    const commentInput = document.getElementById('task-comment-input');
    if (commentInput) {
        commentInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                addTaskComment(id);
            }
        });
    }

    renderTaskActions(task);
    showModal('task-detail-modal');
}

function renderTaskActions(task) {
    const actionsContainer = document.getElementById('task-detail-actions');
    if (!actionsContainer) return;

    let buttonsHtml = '';
    const emp = getEmployee();
    const isAssignee = emp && task.assignee_employee_id === emp.id;
    const isAuthor = emp && task.author_employee_id === emp.id;
    const isAdminRole = emp && emp.position === 'Администратор';

    // Исполнитель: взять в работу
    if (task.status === 'pending' && isAssignee) {
        buttonsHtml += `<button onclick="window.takeTaskToWork(${task.id})" class="bg-yellow-500 hover:bg-yellow-600 text-white font-semibold px-4 py-2 rounded-lg text-sm transition">▶ Взять в работу</button>`;
    }

    // Исполнитель: выполнить (in_progress)
    if (task.status === 'in_progress' && isAssignee) {
        buttonsHtml += `<button onclick="window.openCompleteTaskModal(${task.id})" class="bg-[#15803d] hover:bg-[#166534] text-white font-semibold px-4 py-2 rounded-lg text-sm transition">✅ Отметить выполненной</button>`;
    }

    // Автор / Админ: отменить
    if ((task.status === 'pending' || task.status === 'in_progress') && (isAuthor || isAdminRole)) {
        buttonsHtml += `<button onclick="window.cancelTask(${task.id})" class="bg-gray-500 hover:bg-gray-600 text-white font-semibold px-4 py-2 rounded-lg text-sm transition">⚫ Отменить</button>`;
    }

    // Автор / Админ: удалить (только выполненные или отменённые)
    if ((task.status === 'done' || task.status === 'cancelled') && (isAuthor || isAdminRole)) {
        buttonsHtml += `<button onclick="window.deleteTask(${task.id})" class="bg-red-100 hover:bg-red-200 text-red-700 font-semibold px-4 py-2 rounded-lg text-sm transition">🗑 Удалить</button>`;
    }

    actionsContainer.innerHTML = buttonsHtml;
}

// =====================================================================
// ХЕЛПЕРЫ
// =====================================================================

export function getTaskStatusInfo(status) {
    const map = {
        'pending':     { label: '🟡 Новая',      bg: 'bg-yellow-100', color: 'text-yellow-800', border: 'border-yellow-400' },
        'in_progress': { label: '🔵 В работе',   bg: 'bg-blue-100',   color: 'text-blue-700',   border: 'border-blue-400' },
        'done':        { label: '🟢 Выполнена',  bg: 'bg-green-100',  color: 'text-green-700',  border: 'border-[#15803d]' },
        'cancelled':   { label: '⚫ Отменена',   bg: 'bg-gray-200',   color: 'text-gray-600',   border: 'border-gray-400' }
    };
    return map[status] || { label: status, bg: 'bg-gray-100', color: 'text-gray-700', border: 'border-gray-300' };
}

export function getTaskPriorityInfo(priority) {
    const map = {
        'urgent':    { label: '⚡ Срочно',  bg: 'bg-red-100',    color: 'text-red-700' },
        'important': { label: '⭐ Важный',  bg: 'bg-amber-100',  color: 'text-amber-800' },
        'normal':    { label: '📋 Обычная', bg: 'bg-gray-100',   color: 'text-gray-700' }
    };
    return map[priority] || map.normal;
}

// =====================================================================
// БЕЙДЖ
// =====================================================================

export function updateTasksBadge() {
    const badge = document.getElementById('tasks-badge');
    if (!badge) return;

    const emp = getEmployee();
    if (!emp) return;

    // Счётчик = мои активные задачи (pending + in_progress), где я исполнитель
    const myActive = tasksCache.filter(t => 
        t.assignee_employee_id === emp.id &&
        (t.status === 'pending' || t.status === 'in_progress')
    ).length;

    badge.textContent = myActive;
}

// =====================================================================
// ПРОСМОТР ФОТО
// =====================================================================

export async function viewTaskPhoto(path) {
    if (!path) return;

    const { url, error } = await db.getFileUrl(CONFIG.STORAGE.TASK_PHOTOS_BUCKET || 'task-photos', path, 3600);

    if (error || !url) {
        toast('Не удалось открыть фото', 'error');
        return;
    }

    window.open(url, '_blank');
}
// =====================================================================
// ФОРМА СОЗДАНИЯ ЗАДАЧИ
// =====================================================================

/**
 * Открывает форму создания задачи.
 */
export async function openNewTaskForm() {
    if (!canCreateTask()) {
        toast('Нет прав на создание задачи', 'error');
        return;
    }

    const emp = getEmployee();
    if (!emp) {
        toast('Ваш аккаунт не привязан', 'warning');
        return;
    }

    // Сброс формы
    document.getElementById('new-task-title').value = '';
    document.getElementById('new-task-description').value = '';
    document.getElementById('new-task-project').value = '';
    document.getElementById('new-task-section').innerHTML = '<option value="">Сначала выбери объект</option>';
    document.getElementById('new-task-priority').value = 'normal';
    document.getElementById('new-task-deadline').value = '';
    document.getElementById('new-task-assignee').innerHTML = '<option value="">— Загрузка... —</option>';

    // Загружаем объекты и исполнителей параллельно
    await Promise.all([
        loadProjectsForTask(),
        loadAssigneesForTask()
    ]);

    showModal('new-task-modal');
}

/**
 * Загружает объекты (все — автор может выбрать любой).
 */
async function loadProjectsForTask() {
    const select = document.getElementById('new-task-project');
    if (!select) return;

    const { data, error } = await db.select('projects', {
        orderBy: { column: 'name', asc: true }
    });

    if (error || !data) {
        select.innerHTML = '<option value="">Ошибка загрузки</option>';
        return;
    }

    select.innerHTML = '<option value="">— Без объекта (общая задача) —</option>' +
        data.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
}

/**
 * Загружает разделы выбранного объекта.
 */
export async function loadSectionsForTask() {
    const projectId = parseInt(document.getElementById('new-task-project')?.value, 10);
    const sectionSelect = document.getElementById('new-task-section');
    if (!sectionSelect) return;

    if (!projectId) {
        sectionSelect.innerHTML = '<option value="">— Раздел не нужен —</option>';
        return;
    }

    const { data, error } = await db.select('sections', {
        filters: { project_id: projectId },
        orderBy: { column: 'id', asc: true }
    });

    if (error || !data || data.length === 0) {
        sectionSelect.innerHTML = '<option value="">— Нет разделов —</option>';
        return;
    }

    sectionSelect.innerHTML = '<option value="">— Раздел не нужен —</option>' +
        data.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
}

/**
 * Загружает список исполнителей (Прораб + Снабженец + Инженер ПТО).
 */
async function loadAssigneesForTask() {
    const select = document.getElementById('new-task-assignee');
    if (!select) return;

    const { data, error } = await db.select('employees', {
        filters: { status: 'active' },
        orderBy: { column: 'name', asc: true }
    });

    if (error || !data) {
        select.innerHTML = '<option value="">Ошибка загрузки</option>';
        return;
    }

    // Фильтруем по ролям, которые могут быть исполнителями
    const allowedRoles = ['Прораб', 'Снабженец', 'Инженер ПТО'];
    const assignees = data.filter(e => allowedRoles.includes(e.position));

    if (assignees.length === 0) {
        select.innerHTML = '<option value="">Нет доступных исполнителей</option>';
        return;
    }

    select.innerHTML = '<option value="">— Выбери исполнителя —</option>' +
        assignees.map(e => `<option value="${e.id}">${escapeHtml(e.name)} (${escapeHtml(e.position)})</option>`).join('');
}

/**
 * Сохранение новой задачи.
 */
export async function saveNewTask(event) {
    event.preventDefault();

    if (!canCreateTask()) {
        toast('Нет прав на создание задачи', 'error');
        return;
    }

    const emp = getEmployee();
    if (!emp) {
        toast('Ваш аккаунт не привязан', 'error');
        return;
    }

    const form = event.target;
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Сохраняем...';

    const title = document.getElementById('new-task-title').value.trim();
    const description = document.getElementById('new-task-description').value.trim();
    const projectId = parseInt(document.getElementById('new-task-project').value, 10) || null;
    const sectionId = parseInt(document.getElementById('new-task-section').value, 10) || null;
    const priority = document.getElementById('new-task-priority').value;
    const deadline = document.getElementById('new-task-deadline').value || null;
    const assigneeId = parseInt(document.getElementById('new-task-assignee').value, 10);

    // Валидация
    if (!title) {
        toast('Введи заголовок задачи', 'error');
        submitBtn.disabled = false;
        submitBtn.textContent = '💾 Создать задачу';
        return;
    }
    if (!assigneeId) {
        toast('Выбери исполнителя', 'error');
        submitBtn.disabled = false;
        submitBtn.textContent = '💾 Создать задачу';
        return;
    }

    // Создаём задачу
    const payload = {
        title,
        description: description || null,
        project_id: projectId,
        section_id: sectionId,
        author_employee_id: emp.id,
        assignee_employee_id: assigneeId,
        priority,
        deadline,
        status: 'pending',
        comments: [],
        history: [{
            action: 'Задача создана',
            author: emp.name,
            date: new Date().toISOString()
        }]
    };

    const { error } = await db.insert('tasks', payload);

    if (error) {
        log.error('Ошибка создания задачи:', error.message);
        toast('Не удалось создать задачу: ' + error.message, 'error');
        submitBtn.disabled = false;
        submitBtn.textContent = '💾 Создать задачу';
        return;
    }

    log.info('✅ Задача создана:', title);
    toast('Задача создана', 'success');

    hideModal('new-task-modal');
    form.reset();

    await loadTasks();
}
// =====================================================================
// ОБРАБОТКА ЗАДАЧИ
// =====================================================================

/**
 * Взять задачу в работу (pending → in_progress).
 */
export async function takeTaskToWork(id) {
    const task = tasksCache.find(t => t.id === id);
    if (!task) {
        toast('Задача не найдена', 'error');
        return;
    }

    if (!canCompleteTask(task)) {
        toast('Вы не назначены исполнителем этой задачи', 'error');
        return;
    }

    if (task.status !== 'pending') {
        toast('Задача уже в работе или выполнена', 'warning');
        return;
    }

    const emp = getEmployee();
    const history = Array.isArray(task.history) ? task.history : [];
    history.push({
        action: 'Взято в работу',
        author: emp?.name || '—',
        date: new Date().toISOString()
    });

    const { error } = await db.update('tasks', {
        status: 'in_progress',
        history
    }, { id });

    if (error) {
        toast('Ошибка: ' + error.message, 'error');
        return;
    }

    toast('Задача взята в работу', 'success');
    hideModal('task-detail-modal');
    await loadTasks();
}

/**
 * Открывает модалку выполнения задачи.
 */
export async function openCompleteTaskModal(id) {
    const task = tasksCache.find(t => t.id === id);
    if (!task) {
        toast('Задача не найдена', 'error');
        return;
    }

    if (!canCompleteTask(task)) {
        toast('Вы не назначены исполнителем', 'error');
        return;
    }

    if (task.status !== 'in_progress') {
        toast('Сначала возьмите задачу в работу', 'warning');
        return;
    }

    currentTaskId = id;

    // Скрываем модалку просмотра
    hideModal('task-detail-modal');

    // Заголовок
    const titleEl = document.getElementById('complete-task-title');
    if (titleEl) titleEl.textContent = `✅ Выполнить: ${task.title || task.text || ''}`;

    // Сохраняем id в форму
    document.getElementById('complete-task-id').value = id;

    // Сброс полей
    document.getElementById('complete-task-comment').value = '';
    document.getElementById('complete-task-photo').value = '';

    showModal('complete-task-modal');
}

/**
 * Сохранение выполнения задачи (in_progress → done).
 */
export async function completeTask(event) {
    event.preventDefault();

    const taskId = parseInt(document.getElementById('complete-task-id').value, 10);
    const task = tasksCache.find(t => t.id === taskId);
    if (!task) {
        toast('Задача не найдена', 'error');
        return;
    }

    if (!canCompleteTask(task)) {
        toast('Нет прав', 'error');
        return;
    }

    const emp = getEmployee();
    if (!emp) {
        toast('Ваш аккаунт не привязан', 'error');
        return;
    }

    const form = event.target;
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Сохраняем...';

    const comment = document.getElementById('complete-task-comment').value.trim();
    if (!comment) {
        toast('Перед закрытием задачи обязательно напиши комментарий', 'error');

        const commentInput = document.getElementById('complete-task-comment');
        if (commentInput) {
            commentInput.focus();
            commentInput.classList.add('border-red-500', 'ring-2', 'ring-red-200');
            setTimeout(() => {
                commentInput.classList.remove('border-red-500', 'ring-2', 'ring-red-200');
            }, 1800);
        }

        submitBtn.disabled = false;
        submitBtn.textContent = '✅ Отметить выполненной';
        return;
    }

    const photoFile = document.getElementById('complete-task-photo')?.files[0] || null;

    // Загрузка фотоотчёта (если есть)
    let photoPath = task.photo_path || null;
    if (photoFile) {
        const path = `task_${taskId}/${Date.now()}_${sanitizeFileName(photoFile.name)}`;
        const uploadResult = await db.uploadFile(
            CONFIG.STORAGE.TASK_PHOTOS_BUCKET || 'task-photos', 
            path, 
            photoFile
        );

        if (uploadResult.error) {
            log.warn('Не удалось загрузить фото:', uploadResult.error.message);
            toast('Фото не загружено, но задача закроется', 'warning');
        } else {
            photoPath = uploadResult.path;
        }
    }

    // Добавляем комментарий в список комментариев и в историю
    const comments = Array.isArray(task.comments) ? [...task.comments] : [];
    comments.push({
        text: comment,
        author: emp.name,
        author_id: emp.id,
        date: new Date().toISOString()
    });

    const history = Array.isArray(task.history) ? task.history : [];
    history.push({
        action: 'Задача выполнена',
        author: emp.name,
        date: new Date().toISOString(),
        comment: comment || null
    });

    // Обновляем задачу
    const { error } = await db.update('tasks', {
        status: 'done',
        photo_path: photoPath,
        completed_at: new Date().toISOString(),
        comments,
        history
    }, { id: taskId });

    submitBtn.disabled = false;
    submitBtn.textContent = '✅ Отметить выполненной';

    if (error) {
        toast('Ошибка: ' + error.message, 'error');
        return;
    }

    toast('Задача выполнена', 'success');
    hideModal('complete-task-modal');
    await loadTasks();
}

/**
 * Отменить задачу (только автор или Админ).
 */
export async function cancelTask(id) {
    const task = tasksCache.find(t => t.id === id);
    if (!task) return;

    if (!canCancelTask(task)) {
        toast('Нет прав на отмену задачи', 'error');
        return;
    }

    const reason = prompt('Причина отмены задачи:');
    if (reason === null) return; // отменил ввод

    const emp = getEmployee();
    const history = Array.isArray(task.history) ? task.history : [];
    history.push({
        action: 'Задача отменена',
        author: emp?.name || '—',
        date: new Date().toISOString(),
        reason: reason || null
    });

    const { error } = await db.update('tasks', {
        status: 'cancelled',
        history
    }, { id });

    if (error) {
        toast('Ошибка: ' + error.message, 'error');
        return;
    }

    toast('Задача отменена', 'warning');
    hideModal('task-detail-modal');
    await loadTasks();
}

/**
 * Удалить задачу (только автор или Админ).
 */
export async function deleteTask(id) {
    const task = tasksCache.find(t => t.id === id);
    if (!task) return;

    const emp = getEmployee();
    const isAdminRole = emp && emp.position === 'Администратор';
    const isAuthor = emp && task.author_employee_id === emp.id;

    if (!isAdminRole && !isAuthor) {
        toast('Нет прав на удаление', 'error');
        return;
    }

    if (!confirm(`Удалить задачу "${task.title || task.text}"?\n\nЭто действие нельзя отменить.`)) return;

    // Удаляем фото из Storage (если есть)
    if (task.photo_path) {
        await db.deleteFile(
            CONFIG.STORAGE.TASK_PHOTOS_BUCKET || 'task-photos',
            task.photo_path
        );
    }

    const { error } = await db.remove('tasks', { id });

    if (error) {
        toast('Ошибка удаления: ' + error.message, 'error');
        return;
    }

    toast('Задача удалена', 'success');
    hideModal('task-detail-modal');
    await loadTasks();
}

/**
 * Добавить комментарий к задаче.
 */
export async function addTaskComment(id) {
    const task = tasksCache.find(t => t.id === id);

    if (!task || !canSeeTask(task)) {
        toast('Нет доступа к этой задаче', 'error');
        return;
    }

    const input = document.getElementById('task-comment-input');
    const text = input?.value.trim();

    if (!text) {
        toast('Введи комментарий', 'error');
        return;
    }

    if (text.length > 1000) {
        toast('Комментарий слишком длинный (максимум 1000 символов)', 'error');
        return;
    }

    const emp = getEmployee();
    if (!emp) {
        toast('Ваш аккаунт не привязан', 'error');
        return;
    }

    const comments = Array.isArray(task.comments) ? task.comments : [];
    comments.push({
        text,
        author: emp.name,
        author_id: emp.id,
        date: new Date().toISOString()
    });

    const { error } = await db.update('tasks', {
        comments
    }, { id });

    if (error) {
        toast('Ошибка: ' + error.message, 'error');
        return;
    }

    toast('Комментарий добавлен', 'success');
    // Обновляем карточку
    await loadTasks();
    await openTaskDetail(id);
}

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
    if (!result) result = 'task';
    if (result.length > 60) result = result.slice(0, 60);

    return result + ext.toLowerCase();
}
// =====================================================================
// ГЛОБАЛЬНЫЕ ФУНКЦИИ
// =====================================================================

window.openTaskDetail = openTaskDetail;
window.openTaskFilterModal = openTaskFilterModal;
window.switchTasksTab = switchTasksTab;
window.viewTaskPhoto = viewTaskPhoto;
window.openNewTaskForm = openNewTaskForm;
window.loadSectionsForTask = loadSectionsForTask;
window.takeTaskToWork = takeTaskToWork;
window.openCompleteTaskModal = openCompleteTaskModal;
window.cancelTask = cancelTask;
window.deleteTask = deleteTask;
window.addTaskComment = addTaskComment;