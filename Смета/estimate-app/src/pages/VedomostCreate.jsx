import React, { useState, useEffect } from 'react'
import { useNavigate, useParams, Link } from 'react-router-dom'
import WorkPickerModal from '../components/WorkPickerModal'
import MaterialPickerForVedomost from '../components/MaterialPickerForVedomost'
import LimitsPanel from '../components/LimitsPanel'
import ExportModal from '../components/ExportModal'
import NumberInput from '../components/NumberInput'
import { createVedomost, getVedomost, updateVedomost } from '../api/vedomosti'
import { getClients } from '../api/clients'
import { formatMoney, formatNumber } from '../utils/format'

const roundUp = (value) => Math.ceil(parseFloat(value) || 0)

export default function VedomostCreate() {
  const navigate = useNavigate()
  const { id } = useParams()
  const isEdit = Boolean(id)

  const [title, setTitle] = useState('')
  const [object, setObject] = useState('')
  const [clientId, setClientId] = useState('')
  const [clients, setClients] = useState([])
  const [notes, setNotes] = useState('')
  const [number, setNumber] = useState('')
  const [sections, setSections] = useState([])

  const [limits, setLimits] = useState([])
  const [vatPercent, setVatPercent] = useState(0)
  const [vatBase, setVatBase] = useState('both')

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerSectionId, setPickerSectionId] = useState(null)

  const [materialPickerOpen, setMaterialPickerOpen] = useState(false)
  const [materialPickerTarget, setMaterialPickerTarget] = useState(null)

  const [exportOpen, setExportOpen] = useState(false)

  useEffect(() => {
    loadAll()
  }, [id])

  const loadAll = async () => {
    setLoading(true)
    setError(null)
    try {
      // Загружаем клиентов всегда
      const clientsData = await getClients()
      setClients(clientsData)

      if (isEdit) {
        const v = await getVedomost(id)
        setTitle(v.title || '')
        setObject(v.object || '')
        setClientId(v.clientId || '')
        setNotes(v.notes || '')
        setNumber(v.number || '')

        setLimits(
          (v.limits || []).map((lim) => ({
            name: lim.name || '',
            isCustom: false,
            percent: lim.percent || 0,
            base: lim.base || 'both',
          }))
        )

        setVatPercent(v.vatPercent || 0)
        setVatBase(v.vatBase || 'both')

        setSections(
          (v.sections || []).map((section) => ({
            id: section.id,
            name: section.name,
            collapsed: false,
            items: (section.items || []).map((item) => ({
              id: item.id,
              catalogWorkId: item.catalogWorkId,
              name: item.name,
              unit: item.unit,
              quantity: item.quantity,
              priceWorker: item.priceWorker,
              priceClient: item.priceClient,
              materials: (item.materials || []).map((m) => ({
                id: m.id,
                catalogMaterialId: m.catalogMaterialId,
                name: m.name,
                unit: m.unit,
                quantity: m.quantity,
                pricePurchase: m.pricePurchase,
                priceClient: m.priceClient,
                consumption: m.consumption,
                isCustomerSupplied: m.isCustomerSupplied || false,
              })),
            })),
          }))
        )
      }
    } catch (err) {
      setError('Не вдалося завантажити дані: ' + err.message)
      console.error(err)
    }
    setLoading(false)
  }

  // --- Розділи ---
  const addSection = () => {
    setSections((prev) => [
      ...prev,
      { id: Date.now(), name: '', items: [], collapsed: false },
    ])
  }

  const removeSection = (sectionId) => {
    if (!window.confirm('Видалити розділ з усіма позиціями?')) return
    setSections((prev) => prev.filter((s) => s.id !== sectionId))
  }

  const updateSectionName = (sectionId, newName) => {
    setSections((prev) =>
      prev.map((s) => (s.id === sectionId ? { ...s, name: newName } : s))
    )
  }

  const toggleSection = (sectionId) => {
    setSections((prev) =>
      prev.map((s) =>
        s.id === sectionId ? { ...s, collapsed: !s.collapsed } : s
      )
    )
  }

  // --- Позиції (роботи) ---
  const openWorkPicker = (sectionId) => {
    setPickerSectionId(sectionId)
    setPickerOpen(true)
  }

  const addWorkToSection = (sectionId, work) => {
    const materials = (work.materials || []).map((link) => ({
      id: `temp-${Date.now()}-${link.material?.id}`,
      catalogMaterialId: link.material?.id,
      name: link.material?.name || '',
      unit: link.material?.unit || '',
      consumption: link.consumption || 0,
      quantity: 0,
      pricePurchase: link.material?.pricePurchase || 0,
      priceClient: link.material?.priceClient || 0,
      isCustomerSupplied: false,
    }))

    setSections((prev) =>
      prev.map((s) => {
        if (s.id !== sectionId) return s
        return {
          ...s,
          items: [
            ...s.items,
            {
              id: Date.now(),
              catalogWorkId: work.id,
              name: work.name,
              unit: work.unit,
              quantity: 0,
              priceWorker: work.priceWorker,
              priceClient: work.priceClient,
              materials,
            },
          ],
        }
      })
    )
    setPickerOpen(false)
    setPickerSectionId(null)
  }

  const removeItem = (sectionId, itemId) => {
    const item = sections
      .find((s) => s.id === sectionId)
      ?.items.find((i) => i.id === itemId)
    if (!window.confirm(`Видалити позицію «${item?.name || 'без назви'}»?`)) return

    setSections((prev) =>
      prev.map((s) => {
        if (s.id !== sectionId) return s
        return { ...s, items: s.items.filter((i) => i.id !== itemId) }
      })
    )
  }

  const updateItem = (sectionId, itemId, updates) => {
    setSections((prev) =>
      prev.map((s) => {
        if (s.id !== sectionId) return s
        return {
          ...s,
          items: s.items.map((i) =>
            i.id === itemId ? { ...i, ...updates } : i
          ),
        }
      })
    )
  }

  const changeQuantity = (sectionId, itemId, newQuantity) => {
    const qty = parseFloat(newQuantity) || 0
    setSections((prev) =>
      prev.map((s) => {
        if (s.id !== sectionId) return s
        return {
          ...s,
          items: s.items.map((i) => {
            if (i.id !== itemId) return i
            const updatedMaterials = (i.materials || []).map((m) => ({
              ...m,
              quantity: m.consumption ? m.consumption * qty : m.quantity || 0,
            }))
            return { ...i, quantity: qty, materials: updatedMaterials }
          }),
        }
      })
    )
  }

  // --- Матеріали ---
  const openMaterialPicker = (sectionId, itemId) => {
    setMaterialPickerTarget({ sectionId, itemId })
    setMaterialPickerOpen(true)
  }

  const addMaterialToItem = (material) => {
    if (!materialPickerTarget) return
    const { sectionId, itemId } = materialPickerTarget

    setSections((prev) =>
      prev.map((s) => {
        if (s.id !== sectionId) return s
        return {
          ...s,
          items: s.items.map((i) => {
            if (i.id !== itemId) return i
            return {
              ...i,
              materials: [
                ...(i.materials || []),
                {
                  id: `temp-${Date.now()}-${material.id}`,
                  catalogMaterialId: material.id,
                  name: material.name,
                  unit: material.unit,
                  quantity: 0,
                  pricePurchase: material.pricePurchase,
                  priceClient: material.priceClient,
                  consumption: null,
                  isCustomerSupplied: false,
                },
              ],
            }
          }),
        }
      })
    )
    setMaterialPickerOpen(false)
    setMaterialPickerTarget(null)
  }

  const changeMaterialQuantity = (sectionId, itemId, materialId, newQty) => {
    setSections((prev) =>
      prev.map((s) => {
        if (s.id !== sectionId) return s
        return {
          ...s,
          items: s.items.map((i) => {
            if (i.id !== itemId) return i
            return {
              ...i,
              materials: i.materials.map((m) =>
                m.id === materialId
                  ? { ...m, quantity: parseFloat(newQty) || 0 }
                  : m
              ),
            }
          }),
        }
      })
    )
  }

  const removeMaterial = (sectionId, itemId, materialId) => {
    setSections((prev) =>
      prev.map((s) => {
        if (s.id !== sectionId) return s
        return {
          ...s,
          items: s.items.map((i) => {
            if (i.id !== itemId) return i
            return {
              ...i,
              materials: i.materials.filter((m) => m.id !== materialId),
            }
          }),
        }
      })
    )
  }

  const toggleMaterialCustomer = (sectionId, itemId, materialId) => {
    setSections((prev) =>
      prev.map((s) => {
        if (s.id !== sectionId) return s
        return {
          ...s,
          items: s.items.map((i) => {
            if (i.id !== itemId) return i
            return {
              ...i,
              materials: i.materials.map((m) =>
                m.id === materialId
                  ? { ...m, isCustomerSupplied: !m.isCustomerSupplied }
                  : m
              ),
            }
          }),
        }
      })
    )
  }

  // --- Розрахунки ---
  const getWorkSumNaryad = (item) => {
    const qty = parseFloat(item.quantity) || 0
    return qty * (parseFloat(item.priceWorker) || 0)
  }

  const getWorkSumKoshtorys = (item) => {
    const qty = parseFloat(item.quantity) || 0
    return qty * (parseFloat(item.priceClient) || 0)
  }

  const getMaterialsSumNaryad = (item) =>
    (item.materials || []).reduce((sum, m) => {
      if (m.isCustomerSupplied) return sum
      return sum + roundUp(m.quantity || 0) * (m.pricePurchase || 0)
    }, 0)

  const getMaterialsSumKoshtorys = (item) =>
    (item.materials || []).reduce((sum, m) => {
      if (m.isCustomerSupplied) return sum
      return sum + roundUp(m.quantity || 0) * (m.priceClient || 0)
    }, 0)

  const getItemTotalNaryad = (item) =>
    getWorkSumNaryad(item) + getMaterialsSumNaryad(item)

  const getItemTotalKoshtorys = (item) =>
    getWorkSumKoshtorys(item) + getMaterialsSumKoshtorys(item)

  const getSectionNaryad = (section) =>
    section.items.reduce((sum, i) => sum + getItemTotalNaryad(i), 0)

  const getSectionKoshtorys = (section) =>
    section.items.reduce((sum, i) => sum + getItemTotalKoshtorys(i), 0)

  const getGrandNaryad = () =>
    sections.reduce((sum, s) => sum + getSectionNaryad(s), 0)

  const getGrandWorkKoshtorys = () =>
    sections.reduce(
      (sum, s) =>
        sum + s.items.reduce((s2, i) => s2 + getWorkSumKoshtorys(i), 0),
      0
    )

  const getGrandMatKoshtorys = () =>
    sections.reduce(
      (sum, s) =>
        sum + s.items.reduce((s2, i) => s2 + getMaterialsSumKoshtorys(i), 0),
      0
    )

  const getGrandKoshtorysBase = () =>
    getGrandWorkKoshtorys() + getGrandMatKoshtorys()

  const calcLimitAmount = (percent, base) => {
    const p = parseFloat(percent) || 0
    if (p <= 0) return 0
    const workSum = getGrandWorkKoshtorys()
    const matSum = getGrandMatKoshtorys()
    if (base === 'works') return workSum * (p / 100)
    if (base === 'materials') return matSum * (p / 100)
    return (workSum + matSum) * (p / 100)
  }

  const limitsTotal = limits.reduce(
    (sum, lim) => sum + calcLimitAmount(lim.percent, lim.base),
    0
  )

  const subTotal = getGrandKoshtorysBase() + limitsTotal
  const vatSum =
    parseFloat(vatPercent) > 0 ? subTotal * (parseFloat(vatPercent) / 100) : 0
  const grandTotal = subTotal + vatSum

  const getProfit = () => grandTotal - getGrandNaryad()

  const handleVatChange = (field, value) => {
    if (field === 'vatPercent') setVatPercent(value)
    if (field === 'vatBase') setVatBase(value)
  }

  // --- Збереження ---
  const handleSave = async () => {
    if (!title.trim()) {
      alert('Введіть назву відомості')
      return
    }

    setSaving(true)
    try {
      const sectionsData = sections.map((section) => ({
        name: section.name,
        items: section.items.map((item) => ({
          catalogWorkId: item.catalogWorkId,
          name: item.name,
          unit: item.unit,
          quantity: parseFloat(item.quantity) || 0,
          priceWorker: parseFloat(item.priceWorker) || 0,
          priceClient: parseFloat(item.priceClient) || 0,
          materials: (item.materials || []).map((m) => ({
            catalogMaterialId: m.catalogMaterialId,
            name: m.name,
            unit: m.unit,
            quantity: parseFloat(m.quantity) || 0,
            pricePurchase: parseFloat(m.pricePurchase) || 0,
            priceClient: parseFloat(m.priceClient) || 0,
            consumption: m.consumption ? parseFloat(m.consumption) : null,
            isCustomerSupplied: Boolean(m.isCustomerSupplied),
          })),
        })),
      }))

      const limitsData = limits
        .filter((lim) => lim.name && parseFloat(lim.percent) > 0)
        .map((lim) => ({
          name: lim.name,
          percent: parseFloat(lim.percent) || 0,
          base: lim.base || 'both',
        }))

      const payload = {
        title,
        object,
        clientId: clientId || null,
        notes,
        sections: sectionsData,
        limits: limitsData,
        vatPercent: parseFloat(vatPercent) || 0,
        vatBase: vatBase || 'both',
      }

      if (isEdit) {
        await updateVedomost(id, payload)
      } else {
        await createVedomost(payload)
      }

      navigate('/')
    } catch (err) {
      alert('Помилка збереження: ' + err.message)
      console.error(err)
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="text-center py-12 text-gray-500">Завантаження...</div>
    )
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-800">
            {isEdit ? 'Редагувати відомість' : 'Відомість робіт та матеріалів'}
          </h2>
          {number && (
            <div className="text-sm text-gray-500 mt-1">
              Номер сметы:{' '}
              <span className="font-medium text-gray-700">{number}</span>
            </div>
          )}
        </div>
        <Link to="/" className="text-violet-600 hover:underline">
          ← Назад до відомостей
        </Link>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 p-3 rounded-lg mb-4">
          {error}
        </div>
      )}

      {/* Шапка */}
      <div className="bg-white rounded-lg shadow-sm p-6 mb-6">
        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Назва відомості *
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Наприклад: Ремонт санвузла"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-violet-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Об'єкт / Адреса
            </label>
            <input
              type="text"
              value={object}
              onChange={(e) => setObject(e.target.value)}
              placeholder="вул. Шевченка, 15, кв. 42"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-violet-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Замовник
            </label>
            <select
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-violet-500 bg-white"
            >
              <option value="">— Оберіть клієнта —</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.phone ? ` (${c.phone})` : ''}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Розділи */}
      <div className="bg-white rounded-lg shadow-sm p-6 mb-6">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-semibold text-gray-800">Розділи</h3>
          <button
            onClick={addSection}
            className="bg-violet-600 text-white px-4 py-2 rounded-lg hover:bg-violet-700"
          >
            + Додати розділ
          </button>
        </div>

        {sections.length === 0 ? (
          <p className="text-gray-500 text-center py-8">
            Поки немає розділів. Натисніть «Додати розділ», щоб почати.
          </p>
        ) : (
          <div className="space-y-3">
            {sections.map((section) => (
              <div key={section.id} className="border border-gray-200 rounded-lg">
                <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-t-lg">
                  <button
                    onClick={() => toggleSection(section.id)}
                    className="text-gray-500 hover:text-gray-700 w-6 text-lg"
                  >
                    {section.collapsed ? '▶' : '▼'}
                  </button>

                  <input
                    type="text"
                    value={section.name}
                    onChange={(e) =>
                      updateSectionName(section.id, e.target.value)
                    }
                    placeholder="Назва розділу"
                    className="flex-1 bg-transparent font-medium text-gray-800 focus:outline-none focus:bg-white focus:border focus:border-violet-500 rounded px-2 py-1"
                  />

                  <span className="text-sm text-gray-600 whitespace-nowrap">
                    Наряд:{' '}
                    <span className="font-medium text-gray-800">
                      {formatMoney(getSectionNaryad(section))}
                    </span>
                  </span>
                  <span className="text-sm text-gray-600 whitespace-nowrap">
                    Кошторис:{' '}
                    <span className="font-medium text-gray-800">
                      {formatMoney(getSectionKoshtorys(section))}
                    </span>
                  </span>

                  <button
                    onClick={() => removeSection(section.id)}
                    className="text-red-500 hover:text-red-700 px-2"
                  >
                    ✕
                  </button>
                </div>

                {!section.collapsed && (
                  <div className="p-4">
                    {section.items.length > 0 && (
                      <table className="w-full mb-3 text-sm">
                        <thead>
                          <tr className="text-left text-gray-500 border-b border-gray-200">
                            <th className="pb-2 font-medium">Робота</th>
                            <th className="pb-2 font-medium w-14">Од.</th>
                            <th className="pb-2 font-medium w-20">К-сть</th>
                            <th className="pb-2 font-medium w-24">Наряд</th>
                            <th className="pb-2 font-medium w-24">Кошторис</th>
                            <th className="pb-2 font-medium w-28 text-right">
                              Сума нар.
                            </th>
                            <th className="pb-2 font-medium w-28 text-right">
                              Сума кошт.
                            </th>
                            <th className="pb-2 w-20"></th>
                          </tr>
                        </thead>
                        <tbody>
                          {section.items.map((item) => (
                            <React.Fragment key={item.id}>
                              <tr className="border-b border-gray-100">
                                <td className="py-1 pr-2">{item.name}</td>
                                <td className="py-1 pr-2">{item.unit}</td>
                                <td className="py-1 pr-2">
                                  <NumberInput
                                    value={item.quantity}
                                    onChange={(val) =>
                                      changeQuantity(section.id, item.id, val)
                                    }
                                    className="w-full border border-gray-200 rounded px-2 py-1 focus:outline-none focus:border-violet-500"
                                  />
                                </td>
                                <td className="py-1 pr-2">
                                  <NumberInput
                                    value={item.priceWorker}
                                    onChange={(val) =>
                                      updateItem(section.id, item.id, {
                                        priceWorker: val,
                                      })
                                    }
                                    className="w-full border border-gray-200 rounded px-2 py-1 focus:outline-none focus:border-violet-500"
                                  />
                                </td>
                                <td className="py-1 pr-2">
                                  <NumberInput
                                    value={item.priceClient}
                                    onChange={(val) =>
                                      updateItem(section.id, item.id, {
                                        priceClient: val,
                                      })
                                    }
                                    className="w-full border border-gray-200 rounded px-2 py-1 focus:outline-none focus:border-violet-500"
                                  />
                                </td>
                                <td className="py-1 pr-2 text-right text-gray-800 whitespace-nowrap">
                                  {formatMoney(getWorkSumNaryad(item))}
                                </td>
                                <td className="py-1 pr-2 text-right font-medium text-gray-900 whitespace-nowrap">
                                  {formatMoney(getWorkSumKoshtorys(item))}
                                </td>
                                <td className="py-1 text-center whitespace-nowrap">
                                  <button
                                    onClick={() => {
                                      if (
                                        window.confirm(
                                          'Замінити роботу? Поточна позиція буде скинута.'
                                        )
                                      ) {
                                        removeItem(section.id, item.id)
                                        openWorkPicker(section.id)
                                      }
                                    }}
                                    className="text-violet-500 hover:text-violet-700 mr-2"
                                    title="Замінити роботу"
                                  >
                                    ✏
                                  </button>
                                  <button
                                    onClick={() =>
                                      removeItem(section.id, item.id)
                                    }
                                    className="text-red-500 hover:text-red-700"
                                    title="Видалити"
                                  >
                                    ✕
                                  </button>
                                </td>
                              </tr>

                              {item.materials && item.materials.length > 0 && (
                                <tr className="bg-violet-50">
                                  <td colSpan="8" className="py-2 px-6 text-xs">
                                    <div className="font-medium text-gray-600 mb-1">
                                      Матеріали ({item.materials.length}):
                                    </div>
                                    <table className="w-full">
                                      <thead>
                                        <tr className="text-left text-gray-500 border-b border-violet-200">
                                          <th className="pb-1 font-medium">
                                            Матеріал
                                          </th>
                                          <th className="pb-1 font-medium w-14">
                                            Од.
                                          </th>
                                          <th className="pb-1 font-medium w-20">
                                            К-сть
                                          </th>
                                          <th className="pb-1 font-medium w-20">
                                            Наряд
                                          </th>
                                          <th className="pb-1 font-medium w-20">
                                            Кошторис
                                          </th>
                                          <th className="pb-1 font-medium w-28 text-right">
                                            Сума нар.
                                          </th>
                                          <th className="pb-1 font-medium w-28 text-right">
                                            Сума кошт.
                                          </th>
                                          <th className="pb-1 font-medium w-20 text-center">
                                            Замовник
                                          </th>
                                          <th className="pb-1 w-8"></th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {item.materials.map((mat) => (
                                          <tr key={mat.id}>
                                            <td className="py-0.5 pr-2">
                                              {mat.name}
                                            </td>
                                            <td className="py-0.5 pr-2">
                                              {mat.unit}
                                            </td>
                                            <td className="py-0.5 pr-2">
                                              <NumberInput
                                                value={mat.quantity}
                                                onChange={(val) =>
                                                  changeMaterialQuantity(
                                                    section.id,
                                                    item.id,
                                                    mat.id,
                                                    val
                                                  )
                                                }
                                                className="w-full border border-gray-200 rounded px-2 py-0.5 focus:outline-none focus:border-violet-500 text-xs"
                                              />
                                            </td>
                                            <td className="py-0.5 pr-2 text-gray-600">
                                              {mat.isCustomerSupplied ? (
                                                <span className="text-emerald-600 font-medium">
                                                  Замовник
                                                </span>
                                              ) : (
                                                formatMoney(mat.pricePurchase)
                                              )}
                                            </td>
                                            <td className="py-0.5 pr-2 text-gray-600">
                                              {mat.isCustomerSupplied ? (
                                                <span className="text-emerald-600 font-medium">
                                                  Замовник
                                                </span>
                                              ) : (
                                                formatMoney(mat.priceClient)
                                              )}
                                            </td>
                                            <td className="py-0.5 pr-2 text-right text-gray-800">
                                              {mat.isCustomerSupplied
                                                ? '—'
                                                : formatMoney(
                                                    roundUp(mat.quantity || 0) *
                                                      (mat.pricePurchase || 0)
                                                  )}
                                            </td>
                                            <td className="py-0.5 pr-2 text-right font-medium text-gray-900">
                                              {mat.isCustomerSupplied
                                                ? '—'
                                                : formatMoney(
                                                    roundUp(mat.quantity || 0) *
                                                      (mat.priceClient || 0)
                                                  )}
                                            </td>
                                            <td className="py-0.5 text-center">
                                              <input
                                                type="checkbox"
                                                checked={
                                                  mat.isCustomerSupplied || false
                                                }
                                                onChange={() =>
                                                  toggleMaterialCustomer(
                                                    section.id,
                                                    item.id,
                                                    mat.id
                                                  )
                                                }
                                                className="w-4 h-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500 cursor-pointer"
                                                title="Купує замовник"
                                              />
                                            </td>
                                            <td className="py-0.5 text-center">
                                              <button
                                                onClick={() =>
                                                  removeMaterial(
                                                    section.id,
                                                    item.id,
                                                    mat.id
                                                  )
                                                }
                                                className="text-red-500 hover:text-red-700 text-xs"
                                              >
                                                ✕
                                              </button>
                                            </td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </td>
                                </tr>
                              )}
                            </React.Fragment>
                          ))}
                        </tbody>
                      </table>
                    )}

                    <div className="flex gap-2">
                      <button
                        onClick={() => openWorkPicker(section.id)}
                        className="text-sm bg-violet-50 text-violet-600 px-3 py-1.5 rounded hover:bg-violet-100 font-medium"
                      >
                        + Додати роботу
                      </button>
                      {section.items.length > 0 && (
                        <button
                          onClick={() => {
                            const lastItem = section.items[section.items.length - 1]
                            if (lastItem) {
                              openMaterialPicker(section.id, lastItem.id)
                            }
                          }}
                          className="text-sm bg-emerald-50 text-emerald-600 px-3 py-1.5 rounded hover:bg-emerald-100 font-medium"
                        >
                          + Додати матеріал
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Лимиты + НДС */}
      <LimitsPanel
        limits={limits}
        onChange={setLimits}
        vatPercent={vatPercent}
        vatBase={vatBase}
        onVatChange={handleVatChange}
        workSum={getGrandWorkKoshtorys()}
        matSum={getGrandMatKoshtorys()}
      />

      {/* Примечания */}
      <div className="bg-white rounded-lg shadow-sm p-6 mb-6">
        <h3 className="text-lg font-semibold text-gray-800 mb-3">Примітки</h3>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows="5"
          placeholder="Примітки до відомості. Будуть відображені в PDF."
          className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-violet-500"
        />
      </div>

      {/* Підсумки */}
      <div className="bg-white rounded-lg shadow-sm p-6 mb-6">
        <div className="flex justify-end">
          <div className="w-[500px] space-y-2">
            <div className="flex justify-between text-gray-700">
              <span>Роботи (кошторис):</span>
              <span className="font-medium">
                {formatMoney(getGrandWorkKoshtorys())}
              </span>
            </div>
            <div className="flex justify-between text-gray-700">
              <span>Матеріали (кошторис):</span>
              <span className="font-medium">
                {formatMoney(getGrandMatKoshtorys())}
              </span>
            </div>

            {limitsTotal > 0 && (
              <div className="flex justify-between text-gray-500 text-sm pt-2 border-t border-gray-100">
                <span>Лімітовані витрати:</span>
                <span className="font-medium">
                  {formatMoney(limitsTotal)}
                </span>
              </div>
            )}

            <div className="flex justify-between text-gray-700 border-t border-gray-100 pt-2">
              <span>Проміжний підсумок:</span>
              <span className="font-medium">{formatMoney(subTotal)}</span>
            </div>

            {vatSum > 0 && (
              <div className="flex justify-between text-gray-700">
                <span>ПДВ {vatPercent}%:</span>
                <span className="font-medium">{formatMoney(vatSum)}</span>
              </div>
            )}

            <div className="flex justify-between text-lg font-bold text-gray-900 pt-2 border-t border-gray-300">
              <span>ВСЬОГО:</span>
              <span>{formatMoney(grandTotal)}</span>
            </div>

            <div className="flex justify-between text-gray-600 pt-2 border-t border-gray-100 text-sm">
              <span>Наряд (робітники + матеріали):</span>
              <span>{formatMoney(getGrandNaryad())}</span>
            </div>

            <div className="flex justify-between text-lg font-bold text-emerald-600 pt-2 border-t border-gray-200">
              <span>Прибуток:</span>
              <span>{formatMoney(getProfit())}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Кнопки */}
      <div className="flex justify-end gap-3">
        <button
          onClick={() => navigate('/')}
          disabled={saving}
          className="px-6 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          Скасувати
        </button>

        {isEdit && (
          <button
            onClick={() => setExportOpen(true)}
            disabled={saving}
            className="flex items-center gap-2 bg-gradient-to-br from-emerald-500 to-emerald-600 text-white px-6 py-2 rounded-lg hover:from-emerald-600 hover:to-emerald-700 transition-all shadow-md shadow-emerald-500/25 hover:shadow-lg hover:-translate-y-0.5 disabled:opacity-50"
          >
            📤 Експорт
          </button>
        )}

        <button
          onClick={handleSave}
          disabled={saving}
          className="bg-violet-600 text-white px-6 py-2 rounded-lg hover:bg-violet-700 disabled:opacity-50"
        >
          {saving ? 'Збереження...' : 'Зберегти відомість'}
        </button>
      </div>

      {/* Модалка вибору роботи */}
      {pickerOpen && (
        <WorkPickerModal
          onSelect={(work) => addWorkToSection(pickerSectionId, work)}
          onClose={() => {
            setPickerOpen(false)
            setPickerSectionId(null)
          }}
        />
      )}

      {/* Модалка вибору матеріалу */}
      {materialPickerOpen && (
        <MaterialPickerForVedomost
          onSelect={addMaterialToItem}
          onClose={() => {
            setMaterialPickerOpen(false)
            setMaterialPickerTarget(null)
          }}
        />
      )}

      {/* Модалка експорту */}
      {exportOpen && (
        <ExportModal
          vedomostId={id}
          onClose={() => setExportOpen(false)}
        />
      )}
    </div>
  )
}