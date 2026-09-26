import { useState, useEffect } from 'react'
import MaterialPicker from './MaterialPicker'
import {
  linkMaterialToWork,
  unlinkMaterialFromWork,
  updateMaterialConsumption,
} from '../api/works'
import { getSections } from '../api/catalogSections'
import { getUnits } from '../api/catalogUnits'
import { formatMoney } from '../utils/format'

export default function WorkModal({ work, onSave, onClose }) {
  const [form, setForm] = useState({
    name: '',
    unit: '',
    priceWorker: 0,
    priceClient: 0,
    description: '',
    sectionId: null,
  })

  const [sections, setSections] = useState([])
  const [units, setUnits] = useState([])
  const [materials, setMaterials] = useState([])
  const [showPicker, setShowPicker] = useState(false)
  const [saving, setSaving] = useState(false)

  const [pending, setPending] = useState({
    added: [],
    removed: [],
    updated: {},
  })

  useEffect(() => {
    loadDictionaries()
    if (work) {
      setForm({
        name: work.name || '',
        unit: work.unit || '',
        priceWorker: work.priceWorker || 0,
        priceClient: work.priceClient || 0,
        description: work.description || '',
        sectionId: work.sectionId || null,
      })
      setMaterials(work.materials || [])
    } else {
      setForm({
        name: '',
        unit: '',
        priceWorker: 0,
        priceClient: 0,
        description: '',
        sectionId: null,
      })
      setMaterials([])
    }
    setPending({ added: [], removed: [], updated: {} })
  }, [work])

  const loadDictionaries = async () => {
    try {
      const [sectionsData, unitsData] = await Promise.all([
        getSections(), // все разделы и подразделы
        getUnits(),
      ])
      setSections(sectionsData)
      setUnits(unitsData)
    } catch (err) {
      console.error('Не вдалося завантажити довідники:', err)
    }
  }

  const handleChange = (field, value) => {
    setForm({ ...form, [field]: value })
  }

  const handleSelectMaterial = (material) => {
    const alreadyLinked = materials.some(
      (m) => m.materialId === material.id || m.material?.id === material.id
    )
    if (alreadyLinked) {
      alert('Цей матеріал вже прив\'язано до роботи')
      return
    }

    const tempId = `temp-${Date.now()}`
    const newLink = {
      id: tempId,
      materialId: material.id,
      material,
      consumption: 0,
      isNew: true,
    }

    setMaterials([...materials, newLink])
    setPending((prev) => ({
      ...prev,
      added: [...prev.added, newLink],
    }))
    setShowPicker(false)
  }

  const handleChangeConsumption = (linkId, value) => {
    const numValue = parseFloat(value) || 0

    setMaterials(
      materials.map((m) => (m.id === linkId ? { ...m, consumption: numValue } : m))
    )

    setPending((prev) => {
      const isNew = prev.added.some((a) => a.id === linkId)
      if (isNew) {
        return {
          ...prev,
          added: prev.added.map((a) =>
            a.id === linkId ? { ...a, consumption: numValue } : a
          ),
        }
      }
      return {
        ...prev,
        updated: { ...prev.updated, [linkId]: numValue },
      }
    })
  }

  const handleRemoveMaterial = (linkId) => {
    if (!window.confirm('Відв\'язати матеріал від роботи?')) return

    const isNew = linkId.startsWith('temp-')

    setMaterials(materials.filter((m) => m.id !== linkId))

    setPending((prev) => {
      if (isNew) {
        return {
          ...prev,
          added: prev.added.filter((a) => a.id !== linkId),
        }
      }
      return {
        ...prev,
        removed: [...prev.removed, linkId],
        updated: Object.fromEntries(
          Object.entries(prev.updated).filter(([k]) => k !== linkId)
        ),
      }
    })
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!form.name.trim()) {
      alert('Введіть назву роботи')
      return
    }
    if (!form.unit) {
      alert('Оберіть одиницю виміру')
      return
    }

    setSaving(true)
    try {
      const workData = {
        ...form,
        priceWorker: parseFloat(form.priceWorker) || 0,
        priceClient: parseFloat(form.priceClient) || 0,
        sectionId: form.sectionId || null,
      }

      const savedWork = await onSave(workData)

      if (!savedWork?.id) {
        throw new Error('Не вдалося отримати ID збереженої роботи')
      }

      for (const link of pending.added) {
        await linkMaterialToWork(savedWork.id, link.materialId, link.consumption)
      }

      for (const [linkId, consumption] of Object.entries(pending.updated)) {
        if (linkId.startsWith('temp-')) continue
        await updateMaterialConsumption(savedWork.id, linkId, consumption)
      }

      for (const linkId of pending.removed) {
        await unlinkMaterialFromWork(savedWork.id, linkId)
      }

      onClose()
    } catch (err) {
      console.error('Помилка збереження:', err)
      alert('Помилка збереження: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  // Группируем разделы для выпадающего списка
  const parentSections = sections.filter((s) => !s.parentId)
  const getChildren = (parentId) =>
    sections.filter((s) => s.parentId === parentId)

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center p-4 border-b border-gray-200 sticky top-0 bg-white">
          <h3 className="text-lg font-semibold text-gray-800">
            {work ? 'Редагувати роботу' : 'Нова робота'}
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
              Розділ довідника
            </label>
            <select
              value={form.sectionId || ''}
              onChange={(e) => handleChange('sectionId', e.target.value || null)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-violet-500 bg-white"
            >
              <option value="">— Без розділу —</option>
              {parentSections.map((parent) => {
                const children = getChildren(parent.id)
                if (children.length === 0) {
                  return (
                    <option key={parent.id} value={parent.id}>
                      {parent.name}
                    </option>
                  )
                }
                return (
                  <optgroup key={parent.id} label={parent.name}>
                    <option value={parent.id}>
                      {parent.name} (загальний)
                    </option>
                    {children.map((child) => (
                      <option key={child.id} value={child.id}>
                        └ {child.name}
                      </option>
                    ))}
                  </optgroup>
                )
              })}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Назва *
            </label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => handleChange('name', e.target.value)}
              autoFocus
              className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-violet-500"
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Од. вим. *
              </label>
              <select
                value={form.unit}
                onChange={(e) => handleChange('unit', e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-violet-500 bg-white"
              >
                <option value="">— Оберіть —</option>
                {units.map((u) => (
                  <option key={u.id} value={u.name}>
                    {u.name}
                    {u.fullName ? ` (${u.fullName})` : ''}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Наряд, ₴
              </label>
              <input
                type="number"
                value={form.priceWorker}
                onChange={(e) => handleChange('priceWorker', e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-violet-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Кошторис, ₴
              </label>
              <input
                type="number"
                value={form.priceClient}
                onChange={(e) => handleChange('priceClient', e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-violet-500"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Опис (необов'язково)
            </label>
            <textarea
              value={form.description}
              onChange={(e) => handleChange('description', e.target.value)}
              rows="2"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-violet-500"
            />
          </div>

          <div className="border-t border-gray-200 pt-4">
            <div className="flex justify-between items-center mb-3">
              <h4 className="font-medium text-gray-800">
                Матеріали ({materials.length})
              </h4>
              <button
                type="button"
                onClick={() => setShowPicker(true)}
                className="text-sm bg-stone-50 text-violet-600 px-3 py-1.5 rounded hover:bg-stone-100 font-medium"
              >
                + Прив'язати матеріал
              </button>
            </div>

            {materials.length === 0 ? (
              <p className="text-sm text-gray-500 py-3">
                Матеріали не прив'язані.
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500 border-b border-gray-200">
                    <th className="pb-2 font-medium">Матеріал</th>
                    <th className="pb-2 font-medium w-20">Од.</th>
                    <th className="pb-2 font-medium w-28">Витрата</th>
                    <th className="pb-2 font-medium w-32">Кошторис</th>
                    <th className="pb-2 w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {materials.map((link) => (
                    <tr key={link.id} className="border-b border-gray-100">
                      <td className="py-2">{link.material?.name || '—'}</td>
                      <td className="py-2">{link.material?.unit || '—'}</td>
                      <td className="py-1">
                        <input
                          type="number"
                          value={link.consumption}
                          onChange={(e) =>
                            handleChangeConsumption(link.id, e.target.value)
                          }
                          step="0.01"
                          className="w-full border border-gray-200 rounded px-2 py-1 focus:outline-none focus:border-violet-500"
                        />
                      </td>
                      <td className="py-2 text-gray-700">
                        {formatMoney(link.material?.priceClient || 0)}
                      </td>
                      <td className="py-2 text-center">
                        <button
                          type="button"
                          onClick={() => handleRemoveMaterial(link.id)}
                          className="text-red-500 hover:text-red-700"
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="flex justify-end gap-3 pt-4 border-t border-gray-200">
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

      {showPicker && (
        <MaterialPicker
          onSelect={handleSelectMaterial}
          onClose={() => setShowPicker(false)}
        />
      )}
    </div>
  )
}