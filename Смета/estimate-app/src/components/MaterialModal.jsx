import { useState, useEffect } from 'react'
import { getUnits } from '../api/catalogUnits'
import { getMaterialSections } from '../api/materialSections'
import NumberInput from './NumberInput'

export default function MaterialModal({ material, onSave, onClose }) {
  const [form, setForm] = useState({
    name: '',
    unit: '',
    pricePurchase: 0,
    priceClient: 0,
    materialSectionId: null,
  })
  const [units, setUnits] = useState([])
  const [sections, setSections] = useState([])

  useEffect(() => {
    loadDictionaries()
    if (material) {
      setForm({
        name: material.name || '',
        unit: material.unit || '',
        pricePurchase: material.pricePurchase || 0,
        priceClient: material.priceClient || 0,
        materialSectionId: material.materialSectionId || null,
      })
    }
  }, [material])

  const loadDictionaries = async () => {
    try {
      const [unitsData, sectionsData] = await Promise.all([
        getUnits(),
        getMaterialSections(),
      ])
      setUnits(unitsData)
      setSections(sectionsData)
    } catch (err) {
      console.error(err)
    }
  }

  const handleChange = (field, value) => {
    setForm({ ...form, [field]: value })
  }

  const handleSubmit = (e) => {
    e.preventDefault()
    if (!form.name.trim()) {
      alert('Введіть назву матеріалу')
      return
    }
    if (!form.unit) {
      alert('Оберіть одиницю виміру')
      return
    }
    onSave({
      ...form,
      pricePurchase: parseFloat(form.pricePurchase) || 0,
      priceClient: parseFloat(form.priceClient) || 0,
      materialSectionId: form.materialSectionId || null,
    })
  }

  const parentSections = sections.filter((s) => !s.parentId)
  const getChildren = (parentId) =>
    sections.filter((s) => s.parentId === parentId)

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4 animate-fade-in">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg animate-modal-in">
        <div className="flex justify-between items-center p-5 border-b border-stone-200">
          <h3 className="text-lg font-bold text-stone-900">
            {material ? 'Редагувати матеріал' : 'Новий матеріал'}
          </h3>
          <button
            onClick={onClose}
            className="text-stone-400 hover:text-stone-600 text-xl w-8 h-8 flex items-center justify-center rounded-lg hover:bg-stone-100"
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1.5">
              Розділ
            </label>
            <select
              value={form.materialSectionId || ''}
              onChange={(e) =>
                handleChange('materialSectionId', e.target.value || null)
              }
              className="w-full border border-stone-300 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500 bg-white"
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
                    <option value={parent.id}>{parent.name} (загальний)</option>
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
            <label className="block text-sm font-medium text-stone-700 mb-1.5">
              Назва *
            </label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => handleChange('name', e.target.value)}
              placeholder="Наприклад: Плитка керамічна"
              autoFocus
              className="w-full border border-stone-300 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500"
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-sm font-medium text-stone-700 mb-1.5">
                Од. вим. *
              </label>
              <select
                value={form.unit}
                onChange={(e) => handleChange('unit', e.target.value)}
                className="w-full border border-stone-300 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500 bg-white"
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
              <label className="block text-sm font-medium text-stone-700 mb-1.5">
                Наряд, ₴
              </label>
              <NumberInput
                value={form.pricePurchase}
                onChange={(val) => handleChange('pricePurchase', val)}
                className="w-full border border-stone-300 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-stone-700 mb-1.5">
                Кошторис, ₴
              </label>
              <NumberInput
                value={form.priceClient}
                onChange={(val) => handleChange('priceClient', val)}
                className="w-full border border-stone-300 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500"
              />
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 border border-stone-300 rounded-xl text-stone-700 hover:bg-stone-50 font-medium"
            >
              Скасувати
            </button>
            <button
              type="submit"
              className="bg-gradient-to-br from-violet-500 to-violet-700 text-white px-5 py-2 rounded-xl font-semibold transition-all shadow-md shadow-violet-500/25 hover:shadow-glow-lg hover:-translate-y-0.5"
            >
              Зберегти
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}