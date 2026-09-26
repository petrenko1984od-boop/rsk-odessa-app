import { useState, useEffect } from 'react'
import { getMaterials } from '../api/materials'
import { formatMoney } from '../utils/format'

export default function MaterialPicker({ onSelect, onClose }) {
  const [materials, setMaterials] = useState([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    load()
  }, [])

  const load = async () => {
    setLoading(true)
    try {
      setMaterials(await getMaterials())
    } catch (err) {
      setError('Не вдалося завантажити матеріали')
      console.error(err)
    }
    setLoading(false)
  }

  const filtered = materials.filter((m) =>
    m.name.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[60] p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[80vh] flex flex-col">
        <div className="flex justify-between items-center p-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-800">Вибір матеріалу</h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-xl"
          >
            ✕
          </button>
        </div>

        <div className="p-4 border-b border-gray-200">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Пошук за назвою..."
            autoFocus
            className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-violet-500"
          />
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <p className="text-center py-8 text-gray-500">Завантаження...</p>
          ) : error ? (
            <p className="text-center py-8 text-red-500">{error}</p>
          ) : materials.length === 0 ? (
            <div className="text-center py-8 text-gray-500 px-4">
              <p className="mb-2">У довіднику немає матеріалів.</p>
              <p className="text-sm">
                Спочатку створіть матеріал у вкладці «Матеріали».
              </p>
            </div>
          ) : filtered.length === 0 ? (
            <p className="text-center py-8 text-gray-500">
              Нічого не знайдено за запитом «{search}»
            </p>
          ) : (
            <div>
              {filtered.map((mat) => (
                <button
                  key={mat.id}
                  type="button"
                  onClick={() => onSelect(mat)}
                  className="w-full text-left px-4 py-3 border-b border-gray-100 hover:bg-stone-100"
                >
                  <div className="font-medium text-gray-800">{mat.name}</div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {mat.unit} · Наряд: {formatMoney(mat.pricePurchase)} · Кошторис:{' '}
                    {formatMoney(mat.priceClient)}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

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