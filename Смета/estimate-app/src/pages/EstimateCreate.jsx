import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'

export default function EstimateCreate() {
  const navigate = useNavigate()

  const [title, setTitle] = useState('')
  const [client, setClient] = useState('')
  const [sections, setSections] = useState([])

  // --- Работа с разделами ---
  const addSection = () => {
    setSections([
      ...sections,
      { id: Date.now(), name: '', items: [], collapsed: false }
    ])
  }

  const removeSection = (id) => {
    if (window.confirm('Удалить раздел со всеми позициями?')) {
      setSections(sections.filter((s) => s.id !== id))
    }
  }

  const updateSectionName = (id, newName) => {
    setSections(sections.map((s) => (s.id === id ? { ...s, name: newName } : s)))
  }

  const toggleSection = (id) => {
    setSections(sections.map((s) => (s.id === id ? { ...s, collapsed: !s.collapsed } : s)))
  }

  // --- Работа с позициями ---
  const addItem = (sectionId) => {
    setSections(sections.map((s) => {
      if (s.id !== sectionId) return s
      return {
        ...s,
        items: [
          ...s.items,
          { id: Date.now(), name: '', unit: 'шт', quantity: 0, price: 0 }
        ]
      }
    }))
  }

  const removeItem = (sectionId, itemId) => {
    setSections(sections.map((s) => {
      if (s.id !== sectionId) return s
      return { ...s, items: s.items.filter((i) => i.id !== itemId) }
    }))
  }

  const updateItem = (sectionId, itemId, field, value) => {
    setSections(sections.map((s) => {
      if (s.id !== sectionId) return s
      return {
        ...s,
        items: s.items.map((i) => (i.id === itemId ? { ...i, [field]: value } : i))
      }
    }))
  }

  // --- Подсчёты ---
  const getItemSum = (item) => {
    const q = parseFloat(item.quantity) || 0
    const p = parseFloat(item.price) || 0
    return q * p
  }

  const getSectionTotal = (section) => {
    return section.items.reduce((sum, item) => sum + getItemSum(item), 0)
  }

  const getGrandTotal = () => {
    return sections.reduce((sum, section) => sum + getSectionTotal(section), 0)
  }

  const handleSave = () => {
    console.log('Смета:', { title, client, sections })
    alert('Смета сохранена (пока в консоль). Проверьте F12 → Console.')
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-bold text-gray-800">Новая смета</h2>
        <Link to="/" className="text-violet-600 hover:underline">
          ← Назад к сметам
        </Link>
      </div>

      {/* Шапка сметы */}
      <div className="bg-white rounded-lg shadow-sm p-6 mb-6">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Название сметы
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Например: Ремонт санузла"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-violet-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Клиент
            </label>
            <input
              type="text"
              value={client}
              onChange={(e) => setClient(e.target.value)}
              placeholder="Имя или название компании"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-violet-500"
            />
          </div>
        </div>
      </div>

      {/* Разделы */}
      <div className="bg-white rounded-lg shadow-sm p-6 mb-6">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-semibold text-gray-800">Разделы сметы</h3>
          <button
            onClick={addSection}
            className="bg-violet-600 text-white px-4 py-2 rounded-lg hover:bg-violet-700"
          >
            + Добавить раздел
          </button>
        </div>

        {sections.length === 0 ? (
          <p className="text-gray-500 text-center py-8">
            Пока нет разделов. Нажмите «Добавить раздел», чтобы начать.
          </p>
        ) : (
          <div className="space-y-3">
            {sections.map((section) => (
              <div key={section.id} className="border border-gray-200 rounded-lg">
                {/* Заголовок раздела */}
                <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-t-lg">
                  <button
                    onClick={() => toggleSection(section.id)}
                    className="text-gray-500 hover:text-gray-700 w-6 text-lg"
                    title={section.collapsed ? 'Развернуть' : 'Свернуть'}
                  >
                    {section.collapsed ? '▶' : '▼'}
                  </button>

                  <input
                    type="text"
                    value={section.name}
                    onChange={(e) => updateSectionName(section.id, e.target.value)}
                    placeholder="Название раздела (например, Демонтаж)"
                    className="flex-1 bg-transparent font-medium text-gray-800 focus:outline-none focus:bg-white focus:border focus:border-violet-500 rounded px-2 py-1"
                  />

                  <span className="text-sm font-medium text-gray-700 whitespace-nowrap">
                    {getSectionTotal(section).toFixed(2)} ₽
                  </span>

                  <button
                    onClick={() => removeSection(section.id)}
                    className="text-red-500 hover:text-red-700 px-2"
                    title="Удалить раздел"
                  >
                    ✕
                  </button>
                </div>

                {/* Содержимое раздела */}
                {!section.collapsed && (
                  <div className="p-4">
                    {/* Таблица позиций */}
                    {section.items.length > 0 && (
                      <table className="w-full mb-3 text-sm">
                        <thead>
                          <tr className="text-left text-gray-500 border-b border-gray-200">
                            <th className="pb-2 font-medium">Наименование</th>
                            <th className="pb-2 font-medium w-24">Ед. изм.</th>
                            <th className="pb-2 font-medium w-24">Кол-во</th>
                            <th className="pb-2 font-medium w-28">Цена</th>
                            <th className="pb-2 font-medium w-28 text-right">Сумма</th>
                            <th className="pb-2 w-10"></th>
                          </tr>
                        </thead>
                        <tbody>
                          {section.items.map((item) => (
                            <tr key={item.id} className="border-b border-gray-100">
                              <td className="py-1 pr-2">
                                <input
                                  type="text"
                                  value={item.name}
                                  onChange={(e) => updateItem(section.id, item.id, 'name', e.target.value)}
                                  placeholder="Например: Поклейка обоев"
                                  className="w-full border border-gray-200 rounded px-2 py-1 focus:outline-none focus:border-violet-500"
                                />
                              </td>
                              <td className="py-1 pr-2">
                                <input
                                  type="text"
                                  value={item.unit}
                                  onChange={(e) => updateItem(section.id, item.id, 'unit', e.target.value)}
                                  className="w-full border border-gray-200 rounded px-2 py-1 focus:outline-none focus:border-violet-500"
                                />
                              </td>
                              <td className="py-1 pr-2">
                                <input
                                  type="number"
                                  value={item.quantity}
                                  onChange={(e) => updateItem(section.id, item.id, 'quantity', e.target.value)}
                                  className="w-full border border-gray-200 rounded px-2 py-1 focus:outline-none focus:border-violet-500"
                                />
                              </td>
                              <td className="py-1 pr-2">
                                <input
                                  type="number"
                                  value={item.price}
                                  onChange={(e) => updateItem(section.id, item.id, 'price', e.target.value)}
                                  className="w-full border border-gray-200 rounded px-2 py-1 focus:outline-none focus:border-violet-500"
                                />
                              </td>
                              <td className="py-1 pr-2 text-right font-medium text-gray-800 whitespace-nowrap">
                                {getItemSum(item).toFixed(2)} ₽
                              </td>
                              <td className="py-1 text-center">
                                <button
                                  onClick={() => removeItem(section.id, item.id)}
                                  className="text-red-500 hover:text-red-700"
                                  title="Удалить позицию"
                                >
                                  ✕
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}

                    <button
                      onClick={() => addItem(section.id)}
                      className="text-sm bg-stone-50 text-violet-600 px-3 py-1.5 rounded hover:bg-stone-100 font-medium"
                    >
                      + Добавить позицию
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Итоги */}
      <div className="bg-white rounded-lg shadow-sm p-6 mb-6">
        <div className="flex justify-end">
          <div className="w-64 space-y-2">
            <div className="flex justify-between text-gray-700">
              <span>Подытог:</span>
              <span className="font-medium">{getGrandTotal().toFixed(2)} ₽</span>
            </div>
            <div className="flex justify-between text-gray-700">
              <span>Скидка:</span>
              <span className="font-medium">0.00 ₽</span>
            </div>
            <div className="flex justify-between text-lg font-bold text-gray-900 pt-2 border-t border-gray-200">
              <span>Итого:</span>
              <span>{getGrandTotal().toFixed(2)} ₽</span>
            </div>
          </div>
        </div>
      </div>

      {/* Кнопки */}
      <div className="flex justify-end gap-3">
        <button
          onClick={() => navigate('/')}
          className="px-6 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
        >
          Отмена
        </button>
        <button
          onClick={handleSave}
          className="bg-violet-600 text-white px-6 py-2 rounded-lg hover:bg-violet-700"
        >
          Сохранить смету
        </button>
      </div>
    </div>
  )
}