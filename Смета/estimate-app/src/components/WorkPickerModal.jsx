import { useState, useEffect } from 'react'
import { getSections } from '../api/catalogSections'
import { getWorks } from '../api/works'
import { formatMoney } from '../utils/format'

export default function WorkPickerModal({ onSelect, onClose }) {
  const [sections, setSections] = useState([])
  const [selectedSectionId, setSelectedSectionId] = useState(null)
  const [works, setWorks] = useState([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    loadSections()
  }, [])

  useEffect(() => {
    loadWorks()
  }, [selectedSectionId])

  const loadSections = async () => {
    try {
      setSections(await getSections())
    } catch (err) {
      console.error(err)
    }
  }

  const loadWorks = async () => {
    setLoading(true)
    setError(null)
    try {
      setWorks(await getWorks(selectedSectionId))
    } catch (err) {
      setError('Не вдалося завантажити роботи')
      console.error(err)
    }
    setLoading(false)
  }

  const filtered = search
    ? works.filter((w) =>
        w.name.toLowerCase().includes(search.toLowerCase())
      )
    : works

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[60] p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl max-h-[85vh] flex flex-col">
        {/* Заголовок */}
        <div className="flex justify-between items-center p-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-800">
            Вибір роботи з довідника
          </h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-xl"
          >
            ✕
          </button>
        </div>

        {/* Пошук */}
        <div className="p-4 border-b border-gray-200">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Пошук роботи за назвою..."
            autoFocus
            className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-violet-500"
          />
        </div>

        {/* Дві колонки */}
        <div className="flex-1 flex overflow-hidden">
          {/* Ліва — розділи */}
          <div className="w-64 border-r border-gray-200 overflow-y-auto bg-gray-50">
            <div className="p-2">
              <button
                onClick={() => setSelectedSectionId(null)}
                className={`w-full text-left px-3 py-2 rounded-lg text-sm mb-1 ${
                  selectedSectionId === null
                    ? 'bg-violet-600 text-white font-medium'
                    : 'text-gray-700 hover:bg-gray-100'
                }`}
              >
                Всі роботи
              </button>

              {sections.map((section) => (
                <button
                  key={section.id}
                  onClick={() => setSelectedSectionId(section.id)}
                  className={`w-full text-left px-3 py-2 rounded-lg text-sm mb-1 ${
                    selectedSectionId === section.id
                      ? 'bg-violet-600 text-white font-medium'
                      : 'text-gray-700 hover:bg-gray-100'
                  }`}
                >
                  {section.name}
                  <span className="text-xs opacity-70 ml-1">
                    ({section._count?.works || 0})
                  </span>
                </button>
              ))}

              {sections.length === 0 && (
                <p className="text-xs text-gray-400 p-2">
                  Розділів поки немає. Всі роботи — вгорі.
                </p>
              )}
            </div>
          </div>

          {/* Права — роботи */}
          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <p className="text-center py-8 text-gray-500">Завантаження...</p>
            ) : error ? (
              <p className="text-center py-8 text-red-500">{error}</p>
            ) : filtered.length === 0 ? (
              <p className="text-center py-8 text-gray-500">
                {search
                  ? `Нічого не знайдено за запитом «${search}»`
                  : 'У цьому розділі немає робіт'}
              </p>
            ) : (
              <div>
                {filtered.map((work) => (
                  <button
                    key={work.id}
                    type="button"
                    onClick={() => onSelect(work)}
                    className="w-full text-left px-4 py-3 border-b border-gray-100 hover:bg-stone-100"
                  >
                    <div className="font-medium text-gray-800">{work.name}</div>
                    <div className="text-xs text-gray-500 mt-0.5 flex flex-wrap gap-x-3">
                      <span>{work.unit}</span>
                      <span>Наряд: {formatMoney(work.priceWorker)}</span>
                      <span>Кошторис: {formatMoney(work.priceClient)}</span>
                      {work.materials && work.materials.length > 0 && (
                        <span className="text-violet-600">
                          Матеріалів: {work.materials.length}
                        </span>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Кнопки */}
        <div className="p-4 border-t border-gray-200 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
          >
            Скасувати
          </button>
        </div>
      </div>
    </div>
  )
}