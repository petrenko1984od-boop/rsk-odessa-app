import { useState } from 'react'
import { X, FileText, ClipboardList, Package, Download } from 'lucide-react'
import { downloadExport } from '../api/export'

const TYPES = [
  { value: 'koshtorys', label: 'Кошторис', icon: FileText, hasView: true },
  { value: 'naryad', label: 'Наряд на роботи', icon: ClipboardList, hasView: false },
  { value: 'vedomist', label: 'Ведомість матеріалів', icon: Package, hasView: false },
]

const VIEWS = [
  { value: '6graph', label: '6-ти графка (книжна)' },
  { value: '9graph', label: '9-ти графка (альбомна)' },
]

const COLORS = [
  { value: 'none', label: 'Без кольору', bg: '#FFFFFF' },
  { value: 'violet', label: 'Фіолетовий', bg: '#7C3AED' },
  { value: 'blue', label: 'Синій', bg: '#2563EB' },
  { value: 'emerald', label: 'Смарагдовий', bg: '#059669' },
  { value: 'slate', label: 'Графіт', bg: '#1E293B' },
  { value: 'amber', label: 'Янтарний', bg: '#D97706' },
  { value: 'yellow', label: 'Жовтий', bg: '#EAB308' },
]

const FORMATS = [
  { value: 'pdf', label: 'PDF' },
  { value: 'excel', label: 'Excel (XLSX)' },
]

export default function ExportModal({ vedomostId, onClose }) {
  const [type, setType] = useState('koshtorys')
  const [view, setView] = useState('9graph')
  const [color, setColor] = useState('none')
  const [format, setFormat] = useState('pdf')

  const currentType = TYPES.find((t) => t.value === type)
  const showView = currentType?.hasView === true

  const handleDownload = () => {
    const finalType = type === 'koshtorys' ? view : type

    downloadExport(vedomostId, {
      type: finalType,
      color,
      format,
    })

    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-[70] p-4 animate-fade-in">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto animate-modal-in">
        {/* Заголовок */}
        <div className="flex justify-between items-center p-5 border-b border-stone-200 sticky top-0 bg-white z-10">
          <div className="flex items-center gap-2">
            <Download className="w-5 h-5 text-violet-600" strokeWidth={2.4} />
            <h3 className="text-lg font-bold text-stone-900">
              Експорт документа
            </h3>
          </div>
          <button
            onClick={onClose}
            className="text-stone-400 hover:text-stone-600 w-8 h-8 flex items-center justify-center rounded-lg hover:bg-stone-100"
          >
            <X className="w-4 h-4" strokeWidth={2.4} />
          </button>
        </div>

        <div className="p-5 space-y-5">
          {/* 1. Тип документа */}
          <div>
            <label className="block text-sm font-semibold text-stone-700 mb-2">
              1. Тип документа
            </label>
            <div className="space-y-1.5">
              {TYPES.map((t) => {
                const Icon = t.icon
                const active = type === t.value
                return (
                  <button
                    key={t.value}
                    onClick={() => setType(t.value)}
                    className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl border-2 transition-all text-left ${
                      active
                        ? 'border-violet-500 bg-violet-50'
                        : 'border-stone-200 hover:border-stone-300 hover:bg-stone-50'
                    }`}
                  >
                    <div
                      className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                        active
                          ? 'bg-violet-600 text-white'
                          : 'bg-stone-100 text-stone-500'
                      }`}
                    >
                      <Icon className="w-4 h-4" strokeWidth={2.2} />
                    </div>
                    <span
                      className={`font-medium text-sm ${
                        active ? 'text-violet-900' : 'text-stone-700'
                      }`}
                    >
                      {t.label}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          {/* 2. Вид кошториса — только для "koshtorys" */}
          {showView && (
            <div className="animate-fade-in">
              <label className="block text-sm font-semibold text-stone-700 mb-2">
                2. Вид кошторису
              </label>
              <div className="grid grid-cols-2 gap-2">
                {VIEWS.map((v) => {
                  const active = view === v.value
                  return (
                    <button
                      key={v.value}
                      onClick={() => setView(v.value)}
                      className={`px-3 py-2.5 rounded-xl border-2 transition-all text-sm font-medium ${
                        active
                          ? 'border-violet-500 bg-violet-50 text-violet-900'
                          : 'border-stone-200 text-stone-600 hover:border-stone-300 hover:bg-stone-50'
                      }`}
                    >
                      {v.label}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* 3. Колір шапки */}
          <div>
            <label className="block text-sm font-semibold text-stone-700 mb-2">
              {showView ? '3.' : '2.'} Колір шапки
            </label>
            <div className="flex items-center gap-2 flex-wrap">
              {COLORS.map((c) => {
                const active = color === c.value
                return (
                  <button
                    key={c.value}
                    onClick={() => setColor(c.value)}
                    title={c.label}
                    className={`relative w-7 h-7 rounded-full border-2 transition-all flex items-center justify-center ${
                      active
                        ? 'border-violet-500 ring-2 ring-violet-200 scale-110'
                        : 'border-stone-300 hover:border-stone-500'
                    }`}
                    style={{ backgroundColor: c.bg }}
                  >
                    {c.value === 'none' && (
                      <div className="absolute w-full h-px bg-red-400 rotate-45" />
                    )}
                    {active && (
                      <span
                        className="text-[10px] font-bold leading-none"
                        style={{
                          color:
                            c.value === 'yellow' || c.value === 'none'
                              ? '#000'
                              : '#FFF',
                        }}
                      >
                        ✓
                      </span>
                    )}
                  </button>
                )
              })}

              {/* Название выбранного цвета рядом */}
              <span className="text-xs text-stone-500 ml-1">
                {COLORS.find((c) => c.value === color)?.label}
              </span>
            </div>
          </div>

          {/* 4. Формат */}
          <div>
            <label className="block text-sm font-semibold text-stone-700 mb-2">
              {showView ? '4.' : '3.'} Формат
            </label>
            <div className="grid grid-cols-2 gap-2">
              {FORMATS.map((f) => {
                const active = format === f.value
                return (
                  <button
                    key={f.value}
                    onClick={() => setFormat(f.value)}
                    className={`px-3 py-2.5 rounded-xl border-2 transition-all text-sm font-medium ${
                      active
                        ? 'border-violet-500 bg-violet-50 text-violet-900'
                        : 'border-stone-200 text-stone-600 hover:border-stone-300 hover:bg-stone-50'
                    }`}
                  >
                    {f.label}
                  </button>
                )
              })}
            </div>
          </div>
        </div>

        {/* Кнопки */}
        <div className="p-5 border-t border-stone-200 flex justify-end gap-3 sticky bottom-0 bg-white">
          <button
            onClick={onClose}
            className="px-4 py-2 border border-stone-300 rounded-xl text-stone-700 hover:bg-stone-50 font-medium transition-all"
          >
            Скасувати
          </button>
          <button
            onClick={handleDownload}
            className="flex items-center gap-2 bg-gradient-to-br from-violet-500 to-violet-700 text-white px-5 py-2 rounded-xl font-semibold transition-all shadow-md shadow-violet-500/25 hover:shadow-glow-lg hover:-translate-y-0.5"
          >
            <Download className="w-4 h-4" strokeWidth={2.4} />
            Завантажити
          </button>
        </div>
      </div>
    </div>
  )
}