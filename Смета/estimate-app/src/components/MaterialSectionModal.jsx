import { useState, useEffect } from 'react'
import { getMaterialSections } from '../api/materialSections'

export default function MaterialSectionModal({ section, onSave, onClose }) {
  const [form, setForm] = useState({
    name: '',
    order: 0,
    parentId: null,
  })
  const [parents, setParents] = useState([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    loadParents()
    if (section) {
      setForm({
        name: section.name || '',
        order: section.order || 0,
        parentId: section.parentId || null,
      })
    }
  }, [section])

  const loadParents = async () => {
    try {
      const all = await getMaterialSections({ parentId: 'null' })
      setParents(all.filter((p) => !section || p.id !== section.id))
    } catch (err) {
      console.error(err)
    }
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!form.name.trim()) {
      alert('Введіть назву розділу')
      return
    }
    setSaving(true)
    try {
      await onSave({
        name: form.name.trim(),
        order: parseInt(form.order) || 0,
        parentId: form.parentId || null,
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md">
        <div className="flex justify-between items-center p-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-800">
            {section ? 'Редагувати розділ' : 'Новий розділ матеріалів'}
          </h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-xl"
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Назва розділу *
            </label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Наприклад: Сухі суміші"
              autoFocus
              className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-violet-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Батьківський розділ
            </label>
            <select
              value={form.parentId || ''}
              onChange={(e) =>
                setForm({ ...form, parentId: e.target.value || null })
              }
              className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-violet-500 bg-white"
            >
              <option value="">— Верхній рівень —</option>
              {parents.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Порядок (менше = вище)
            </label>
            <input
              type="number"
              value={form.order}
              onChange={(e) => setForm({ ...form, order: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-violet-500"
            />
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Скасувати
            </button>
            <button
              type="submit"
              disabled={saving}
              className="bg-violet-600 text-white px-4 py-2 rounded-lg hover:bg-violet-700 disabled:opacity-50"
            >
              {saving ? 'Збереження...' : 'Зберегти'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}