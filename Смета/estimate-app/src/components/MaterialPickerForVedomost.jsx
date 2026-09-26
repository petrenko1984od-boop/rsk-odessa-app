import { useState, useEffect } from 'react'
import { getMaterials } from '../api/materials'
import { getMaterialSections } from '../api/materialSections'
import { formatMoney } from '../utils/format'

export default function MaterialPickerForVedomost({ onSelect, onClose }) {
  const [sections, setSections] = useState([])
  const [selectedSectionId, setSelectedSectionId] = useState(null)
  const [materials, setMaterials] = useState([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    loadSections()
  }, [])

  useEffect(() => {
    loadMaterials()
  }, [selectedSectionId])

  const loadSections = async () => {
    try {
      setSections(await getMaterialSections())
    } catch (err) {
      console.error(err)
    }
  }

  const loadMaterials = async () => {
    setLoading(true)
    setError(null)
    try {
      setMaterials(await getMaterials(selectedSectionId))
    } catch (err) {
      setError('Не вдалося завантажити матеріали')
      console.error(err)
    }
    setLoading(false)
  }

  const filtered = search
    ? materials.filter((m) =>
        m.name.toLowerCase().includes(search.toLowerCase())
      )
    : materials

  const parentSections = sections.filter((s) => !s.parentId)
  const getChildren = (parentId) =>
    sections.filter((s) => s.parentId === parentId)

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[70] p-4 animate-fade-in">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col animate-modal-in">
        <div className="flex justify-between items-center p-5 border-b border-stone-200">
          <h3 className="text-lg font-bold text-stone-900">
            Вибір матеріалу з довідника
          </h3>
          <button
            onClick={onClose}
            className="text-stone-400 hover:text-stone-600 text-xl w-8 h-8 flex items-center justify-center rounded-lg hover:bg-stone-100"
          >
            ✕
          </button>
        </div>

        <div className="p-5 border-b border-stone-200">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Пошук матеріалу за назвою..."
            autoFocus
            className="w-full border border-stone-300 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-violet-500"
          />
        </div>

        <div className="flex-1 flex overflow-hidden">
          {/* Ліва — розділи */}
          <div className="w-64 border-r border-stone-200 overflow-y-auto bg-stone-50">
            <div className="p-3">
              <button
                onClick={() => setSelectedSectionId(null)}
                className={`w-full text-left px-3 py-2 rounded-lg text-sm mb-1 ${
                  selectedSectionId === null
                    ? 'bg-violet-600 text-white font-medium'
                    : 'text-stone-700 hover:bg-stone-100'
                }`}
              >
                Всі матеріали
              </button>

              {parentSections.map((parent) => {
                const children = getChildren(parent.id)
                return (
                  <div key={parent.id} className="mb-1">
                    <button
                      onClick={() => setSelectedSectionId(parent.id)}
                      className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium ${
                        selectedSectionId === parent.id
                          ? 'bg-violet-600 text-white'
                          : 'text-stone-800 hover:bg-stone-100'
                      }`}
                    >
                      📁 {parent.name}
                    </button>
                    {children.length > 0 && (
                      <div className="ml-3 mt-0.5 space-y-0.5">
                        {children.map((child) => (
                          <button
                            key={child.id}
                            onClick={() => setSelectedSectionId(child.id)}
                            className={`w-full text-left px-3 py-1.5 rounded-lg text-xs ${
                              selectedSectionId === child.id
                                ? 'bg-violet-500 text-white'
                                : 'text-stone-600 hover:bg-stone-100'
                            }`}
                          >
                            📄 {child.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}

              {sections.length === 0 && (
                <p className="text-xs text-stone-400 p-2">
                  Розділів поки немає.
                </p>
              )}
            </div>
          </div>

          {/* Права — матеріали */}
          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <p className="text-center py-8 text-stone-500">Завантаження...</p>
            ) : error ? (
              <p className="text-center py-8 text-red-500">{error}</p>
            ) : filtered.length === 0 ? (
              <p className="text-center py-8 text-stone-500">
                {search
                  ? `Нічого не знайдено за запитом «${search}»`
                  : 'Матеріалів у цьому розділі немає'}
              </p>
            ) : (
              <div>
                {filtered.map((mat) => (
                  <button
                    key={mat.id}
                    type="button"
                    onClick={() => onSelect(mat)}
                    className="w-full text-left px-4 py-3 border-b border-stone-100 hover:bg-violet-50"
                  >
                    <div className="font-medium text-stone-800">{mat.name}</div>
                    <div className="text-xs text-stone-500 mt-0.5 flex flex-wrap gap-x-3">
                      <span>{mat.unit}</span>
                      <span>Наряд: {formatMoney(mat.pricePurchase)}</span>
                      <span>Кошторис: {formatMoney(mat.priceClient)}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="p-5 border-t border-stone-200 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 border border-stone-300 rounded-xl text-stone-700 hover:bg-stone-50 font-medium"
          >
            Скасувати
          </button>
        </div>
      </div>
    </div>
  )
}