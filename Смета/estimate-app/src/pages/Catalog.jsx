import { useState, useEffect } from 'react'
import { getWorks, createWork, updateWork, deleteWork } from '../api/works'
import { getMaterials, createMaterial, updateMaterial, deleteMaterial } from '../api/materials'
import {
  getSections,
  createSection,
  updateSection,
  deleteSection,
} from '../api/catalogSections'
import {
  getMaterialSections,
  createMaterialSection,
  updateMaterialSection,
  deleteMaterialSection,
} from '../api/materialSections'
import {
  getUnits,
  createUnit,
  updateUnit,
  deleteUnit,
} from '../api/catalogUnits'
import WorkModal from '../components/WorkModal'
import MaterialModal from '../components/MaterialModal'
import SectionModal from '../components/SectionModal'
import MaterialSectionModal from '../components/MaterialSectionModal'
import UnitModal from '../components/UnitModal'
import { formatMoney } from '../utils/format'

export default function Catalog() {
  const [tab, setTab] = useState('works') // 'works' | 'materials' | 'units'

  // ==== Работы ====
  const [workSections, setWorkSections] = useState([])
  const [selectedWorkSectionId, setSelectedWorkSectionId] = useState(null)
  const [works, setWorks] = useState([])

  // ==== Материалы ====
  const [materialSections, setMaterialSections] = useState([])
  const [selectedMaterialSectionId, setSelectedMaterialSectionId] = useState(null)
  const [materials, setMaterials] = useState([])

  // ==== Единицы ====
  const [units, setUnits] = useState([])

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  // Модалки
  const [workModalOpen, setWorkModalOpen] = useState(false)
  const [editingWork, setEditingWork] = useState(null)

  const [materialModalOpen, setMaterialModalOpen] = useState(false)
  const [editingMaterial, setEditingMaterial] = useState(null)

  const [sectionModalOpen, setSectionModalOpen] = useState(false)
  const [editingSection, setEditingSection] = useState(null)

  const [materialSectionModalOpen, setMaterialSectionModalOpen] = useState(false)
  const [editingMaterialSection, setEditingMaterialSection] = useState(null)

  const [unitModalOpen, setUnitModalOpen] = useState(false)
  const [editingUnit, setEditingUnit] = useState(null)

  // Открытые родительские разделы (для сворачивания)
  const [expandedWorkSections, setExpandedWorkSections] = useState({})
  const [expandedMaterialSections, setExpandedMaterialSections] = useState({})

  useEffect(() => {
    loadData()
  }, [tab, selectedWorkSectionId, selectedMaterialSectionId])

  const loadData = async () => {
    setLoading(true)
    setError(null)
    try {
      if (tab === 'works') {
        const sectionsData = await getSections()
        setWorkSections(sectionsData)
        const worksData = await getWorks(selectedWorkSectionId)
        setWorks(worksData)
      } else if (tab === 'materials') {
        const sectionsData = await getMaterialSections()
        setMaterialSections(sectionsData)
        const materialsData = await getMaterials(selectedMaterialSectionId)
        setMaterials(materialsData)
      } else if (tab === 'units') {
        setUnits(await getUnits())
      }
    } catch (err) {
      setError('Не вдалося завантажити дані. Перевірте backend.')
      console.error(err)
    }
    setLoading(false)
  }

  // ============ РАБОТЫ ============
  const openNewWork = () => {
    setEditingWork(null)
    setWorkModalOpen(true)
  }

  const openEditWork = (work) => {
    setEditingWork(work)
    setWorkModalOpen(true)
  }

  const handleSaveWork = async (workData) => {
    try {
      let savedWork
      if (editingWork) {
        savedWork = await updateWork(editingWork.id, workData)
      } else {
        savedWork = await createWork(workData)
      }
      await loadData()
      return savedWork
    } catch (err) {
      alert('Помилка збереження: ' + err.message)
      throw err
    }
  }

  const handleDeleteWork = async (id) => {
    if (!window.confirm('Видалити роботу?')) return
    try {
      await deleteWork(id)
      await loadData()
    } catch (err) {
      alert('Помилка видалення: ' + err.message)
    }
  }

  // Разделы работ
  const openNewSection = () => {
    setEditingSection(null)
    setSectionModalOpen(true)
  }

  const openEditSection = (section) => {
    setEditingSection(section)
    setSectionModalOpen(true)
  }

  const handleSaveSection = async (sectionData) => {
    try {
      if (editingSection) {
        await updateSection(editingSection.id, sectionData)
      } else {
        await createSection(sectionData)
      }
      setSectionModalOpen(false)
      setEditingSection(null)
      await loadData()
    } catch (err) {
      alert('Помилка збереження: ' + err.message)
    }
  }

  const handleDeleteSection = async (section) => {
    if (
      !window.confirm(
        `Видалити розділ «${section.name}»?\nВсі підрозділи та роботи залишаться без розділу.`
      )
    )
      return
    try {
      await deleteSection(section.id)
      if (selectedWorkSectionId === section.id) {
        setSelectedWorkSectionId(null)
      }
      await loadData()
    } catch (err) {
      alert('Помилка видалення: ' + err.message)
    }
  }

  const toggleWorkSection = (id) => {
    setExpandedWorkSections((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  // ============ МАТЕРИАЛЫ ============
  const openNewMaterial = () => {
    setEditingMaterial(null)
    setMaterialModalOpen(true)
  }

  const openEditMaterial = (material) => {
    setEditingMaterial(material)
    setMaterialModalOpen(true)
  }

  const handleSaveMaterial = async (materialData) => {
    try {
      if (editingMaterial) {
        await updateMaterial(editingMaterial.id, materialData)
      } else {
        await createMaterial(materialData)
      }
      setMaterialModalOpen(false)
      setEditingMaterial(null)
      await loadData()
    } catch (err) {
      alert('Помилка збереження: ' + err.message)
    }
  }

  const handleDeleteMaterial = async (id) => {
    if (!window.confirm('Видалити матеріал?')) return
    try {
      await deleteMaterial(id)
      await loadData()
    } catch (err) {
      alert('Помилка видалення: ' + err.message)
    }
  }

  // Разделы материалов
  const openNewMaterialSection = () => {
    setEditingMaterialSection(null)
    setMaterialSectionModalOpen(true)
  }

  const openEditMaterialSection = (section) => {
    setEditingMaterialSection(section)
    setMaterialSectionModalOpen(true)
  }

  const handleSaveMaterialSection = async (sectionData) => {
    try {
      if (editingMaterialSection) {
        await updateMaterialSection(editingMaterialSection.id, sectionData)
      } else {
        await createMaterialSection(sectionData)
      }
      setMaterialSectionModalOpen(false)
      setEditingMaterialSection(null)
      await loadData()
    } catch (err) {
      alert('Помилка збереження: ' + err.message)
    }
  }

  const handleDeleteMaterialSection = async (section) => {
    if (
      !window.confirm(
        `Видалити розділ «${section.name}»?\nВсі підрозділи та матеріали залишаться без розділу.`
      )
    )
      return
    try {
      await deleteMaterialSection(section.id)
      if (selectedMaterialSectionId === section.id) {
        setSelectedMaterialSectionId(null)
      }
      await loadData()
    } catch (err) {
      alert('Помилка видалення: ' + err.message)
    }
  }

  const toggleMaterialSection = (id) => {
    setExpandedMaterialSections((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  // ============ ЕДИНИЦЫ ============
  const openNewUnit = () => {
    setEditingUnit(null)
    setUnitModalOpen(true)
  }

  const openEditUnit = (unit) => {
    setEditingUnit(unit)
    setUnitModalOpen(true)
  }

  const handleSaveUnit = async (unitData) => {
    try {
      if (editingUnit) {
        await updateUnit(editingUnit.id, unitData)
      } else {
        await createUnit(unitData)
      }
      setUnitModalOpen(false)
      setEditingUnit(null)
      await loadData()
    } catch (err) {
      alert('Помилка збереження: ' + err.message)
    }
  }

  const handleDeleteUnit = async (id) => {
    if (!window.confirm('Видалити одиницю виміру?')) return
    try {
      await deleteUnit(id)
      await loadData()
    } catch (err) {
      alert('Помилка видалення: ' + err.message)
    }
  }

  // ============ ВСПОМОГАТЕЛЬНЫЕ ============
  const getParentSections = (list) => list.filter((s) => !s.parentId)
  const getChildSections = (list, parentId) =>
    list.filter((s) => s.parentId === parentId)

  const renderSectionTree = (list, expandedState, toggleFn, onSelect, selectedId, onEdit, onDelete) => {
    const parents = getParentSections(list)

    return parents.map((parent) => {
      const children = getChildSections(list, parent.id)
      const isExpanded = expandedState[parent.id]

      return (
        <div key={parent.id} className="mb-1">
          <div
            className={`group flex items-center gap-1 px-2 py-1.5 rounded-lg text-sm cursor-pointer ${
              selectedId === parent.id
                ? 'bg-stone-50 text-violet-700 font-medium'
                : 'text-gray-700 hover:bg-gray-50'
            }`}
          >
            {children.length > 0 && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  toggleFn(parent.id)
                }}
                className="text-gray-400 hover:text-gray-600 w-4 text-xs"
              >
                {isExpanded ? '▼' : '▶'}
              </button>
            )}
            {children.length === 0 && <span className="w-4"></span>}

            <span
              className="flex-1 truncate"
              onClick={() => onSelect(parent.id)}
            >
              📁 {parent.name}
              <span className="text-xs text-gray-400 ml-1">
                ({parent._count?.works ?? parent._count?.materials ?? 0})
              </span>
            </span>

            <div className="opacity-0 group-hover:opacity-100 flex gap-1">
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onEdit(parent)
                }}
                className="text-violet-600 hover:text-violet-700 text-xs"
              >
                ✏
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onDelete(parent)
                }}
                className="text-red-500 hover:text-red-700 text-xs"
              >
                ✕
              </button>
            </div>
          </div>

          {isExpanded && children.length > 0 && (
            <div className="ml-4 mt-1 space-y-0.5">
              {children.map((child) => (
                <div
                  key={child.id}
                  className={`group flex items-center gap-1 px-2 py-1.5 rounded-lg text-sm cursor-pointer ${
                    selectedId === child.id
                      ? 'bg-stone-50 text-violet-700 font-medium'
                      : 'text-gray-600 hover:bg-gray-50'
                  }`}
                  onClick={() => onSelect(child.id)}
                >
                  <span className="w-4"></span>
                  <span className="flex-1 truncate">
                    📄 {child.name}
                    <span className="text-xs text-gray-400 ml-1">
                      ({child._count?.works ?? child._count?.materials ?? 0})
                    </span>
                  </span>
                  <div className="opacity-0 group-hover:opacity-100 flex gap-1">
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        onEdit(child)
                      }}
                      className="text-violet-600 hover:text-violet-700 text-xs"
                    >
                      ✏
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        onDelete(child)
                      }}
                      className="text-red-500 hover:text-red-700 text-xs"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )
    })
  }

  // ============ РЕНДЕР ============
  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-800 mb-6">Довідники</h2>

      {/* Вкладки */}
      <div className="flex gap-2 mb-4">
        <button
          onClick={() => setTab('works')}
          className={`px-4 py-2 rounded-lg font-medium ${
            tab === 'works'
              ? 'bg-violet-600 text-white'
              : 'bg-white text-gray-700 hover:bg-gray-50'
          }`}
        >
          Роботи
        </button>
        <button
          onClick={() => setTab('materials')}
          className={`px-4 py-2 rounded-lg font-medium ${
            tab === 'materials'
              ? 'bg-violet-600 text-white'
              : 'bg-white text-gray-700 hover:bg-gray-50'
          }`}
        >
          Матеріали
        </button>
        <button
          onClick={() => setTab('units')}
          className={`px-4 py-2 rounded-lg font-medium ${
            tab === 'units'
              ? 'bg-violet-600 text-white'
              : 'bg-white text-gray-700 hover:bg-gray-50'
          }`}
        >
          Одиниці виміру
        </button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 p-3 rounded-lg mb-4">
          {error}
        </div>
      )}

      {/* ============ РОБОТИ ============ */}
      {tab === 'works' && (
        <div className="grid grid-cols-4 gap-4">
          <div className="col-span-1 bg-white rounded-lg shadow-sm p-4">
            <div className="flex justify-between items-center mb-3">
              <h3 className="font-semibold text-gray-800">Розділи</h3>
              <button
                onClick={openNewSection}
                className="text-violet-600 hover:text-violet-700 text-sm font-medium"
              >
                + Додати
              </button>
            </div>

            <div className="space-y-1">
              <button
                onClick={() => setSelectedWorkSectionId(null)}
                className={`w-full text-left px-3 py-2 rounded-lg text-sm ${
                  selectedWorkSectionId === null
                    ? 'bg-stone-50 text-violet-700 font-medium'
                    : 'text-gray-700 hover:bg-gray-50'
                }`}
              >
                Всі роботи ({works.length})
              </button>

              {renderSectionTree(
                workSections,
                expandedWorkSections,
                toggleWorkSection,
                setSelectedWorkSectionId,
                selectedWorkSectionId,
                openEditSection,
                handleDeleteSection
              )}

              {workSections.length === 0 && (
                <p className="text-xs text-gray-400 py-2">
                  Поки немає розділів.
                </p>
              )}
            </div>
          </div>

          <div className="col-span-3 bg-white rounded-lg shadow-sm p-6">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-semibold text-gray-800">
                {selectedWorkSectionId
                  ? workSections.find((s) => s.id === selectedWorkSectionId)
                      ?.name || 'Роботи'
                  : 'Всі роботи'}{' '}
                ({works.length})
              </h3>
              <button
                onClick={openNewWork}
                className="bg-violet-600 text-white px-4 py-2 rounded-lg hover:bg-violet-700"
              >
                + Додати роботу
              </button>
            </div>

            {loading ? (
              <p className="text-gray-500 text-center py-8">Завантаження...</p>
            ) : works.length === 0 ? (
              <p className="text-gray-500 text-center py-8">Робіт поки немає.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500 border-b border-gray-200">
                    <th className="pb-2 font-medium">Назва</th>
                    <th className="pb-2 font-medium w-20">Од.</th>
                    <th className="pb-2 font-medium w-28">Наряд</th>
                    <th className="pb-2 font-medium w-28">Кошторис</th>
                    <th className="pb-2 font-medium w-28">Матеріалів</th>
                    <th className="pb-2 w-20"></th>
                  </tr>
                </thead>
                <tbody>
                  {works.map((work) => (
                    <tr
                      key={work.id}
                      className="border-b border-gray-100 hover:bg-gray-50"
                    >
                      <td
                        className="py-2 cursor-pointer"
                        onClick={() => openEditWork(work)}
                      >
                        {work.name}
                      </td>
                      <td className="py-2">{work.unit}</td>
                      <td className="py-2">{formatMoney(work.priceWorker)}</td>
                      <td className="py-2">{formatMoney(work.priceClient)}</td>
                      <td className="py-2 text-gray-500">
                        {work.materials ? work.materials.length : 0}
                      </td>
                      <td className="py-2 text-right whitespace-nowrap">
                        <button
                          onClick={() => openEditWork(work)}
                          className="text-violet-600 hover:text-violet-700 mr-3"
                        >
                          ✏
                        </button>
                        <button
                          onClick={() => handleDeleteWork(work.id)}
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
        </div>
      )}

      {/* ============ МАТЕРИАЛЫ ============ */}
      {tab === 'materials' && (
        <div className="grid grid-cols-4 gap-4">
          <div className="col-span-1 bg-white rounded-lg shadow-sm p-4">
            <div className="flex justify-between items-center mb-3">
              <h3 className="font-semibold text-gray-800">Розділи</h3>
              <button
                onClick={openNewMaterialSection}
                className="text-violet-600 hover:text-violet-700 text-sm font-medium"
              >
                + Додати
              </button>
            </div>

            <div className="space-y-1">
              <button
                onClick={() => setSelectedMaterialSectionId(null)}
                className={`w-full text-left px-3 py-2 rounded-lg text-sm ${
                  selectedMaterialSectionId === null
                    ? 'bg-stone-50 text-violet-700 font-medium'
                    : 'text-gray-700 hover:bg-gray-50'
                }`}
              >
                Всі матеріали ({materials.length})
              </button>

              {renderSectionTree(
                materialSections,
                expandedMaterialSections,
                toggleMaterialSection,
                setSelectedMaterialSectionId,
                selectedMaterialSectionId,
                openEditMaterialSection,
                handleDeleteMaterialSection
              )}

              {materialSections.length === 0 && (
                <p className="text-xs text-gray-400 py-2">
                  Поки немає розділів.
                </p>
              )}
            </div>
          </div>

          <div className="col-span-3 bg-white rounded-lg shadow-sm p-6">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-semibold text-gray-800">
                {selectedMaterialSectionId
                  ? materialSections.find(
                      (s) => s.id === selectedMaterialSectionId
                    )?.name || 'Матеріали'
                  : 'Всі матеріали'}{' '}
                ({materials.length})
              </h3>
              <button
                onClick={openNewMaterial}
                className="bg-violet-600 text-white px-4 py-2 rounded-lg hover:bg-violet-700"
              >
                + Додати матеріал
              </button>
            </div>

            {loading ? (
              <p className="text-gray-500 text-center py-8">Завантаження...</p>
            ) : materials.length === 0 ? (
              <p className="text-gray-500 text-center py-8">
                Матеріалів поки немає.
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500 border-b border-gray-200">
                    <th className="pb-2 font-medium">Назва</th>
                    <th className="pb-2 font-medium w-20">Од.</th>
                    <th className="pb-2 font-medium w-28">Наряд</th>
                    <th className="pb-2 font-medium w-28">Кошторис</th>
                    <th className="pb-2 w-20"></th>
                  </tr>
                </thead>
                <tbody>
                  {materials.map((mat) => (
                    <tr
                      key={mat.id}
                      className="border-b border-gray-100 hover:bg-gray-50"
                    >
                      <td
                        className="py-2 cursor-pointer"
                        onClick={() => openEditMaterial(mat)}
                      >
                        {mat.name}
                      </td>
                      <td className="py-2">{mat.unit}</td>
                      <td className="py-2">{formatMoney(mat.pricePurchase)}</td>
                      <td className="py-2">{formatMoney(mat.priceClient)}</td>
                      <td className="py-2 text-right whitespace-nowrap">
                        <button
                          onClick={() => openEditMaterial(mat)}
                          className="text-violet-600 hover:text-violet-700 mr-3"
                        >
                          ✏
                        </button>
                        <button
                          onClick={() => handleDeleteMaterial(mat.id)}
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
        </div>
      )}

      {/* ============ ЕДИНИЦЫ ============ */}
      {tab === 'units' && (
        <div className="bg-white rounded-lg shadow-sm p-6">
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-lg font-semibold text-gray-800">
              Одиниці виміру ({units.length})
            </h3>
            <button
              onClick={openNewUnit}
              className="bg-violet-600 text-white px-4 py-2 rounded-lg hover:bg-violet-700"
            >
              + Додати
            </button>
          </div>

          {loading ? (
            <p className="text-gray-500 text-center py-8">Завантаження...</p>
          ) : units.length === 0 ? (
            <p className="text-gray-500 text-center py-8">
              Одиниць виміру поки немає.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b border-gray-200">
                  <th className="pb-2 font-medium w-24">Скорочено</th>
                  <th className="pb-2 font-medium">Повна назва</th>
                  <th className="pb-2 font-medium w-24">Порядок</th>
                  <th className="pb-2 w-20"></th>
                </tr>
              </thead>
              <tbody>
                {units.map((unit) => (
                  <tr
                    key={unit.id}
                    className="border-b border-gray-100 hover:bg-gray-50"
                  >
                    <td className="py-2 font-medium">{unit.name}</td>
                    <td className="py-2 text-gray-600">{unit.fullName || '—'}</td>
                    <td className="py-2 text-gray-500">{unit.order}</td>
                    <td className="py-2 text-right whitespace-nowrap">
                      <button
                        onClick={() => openEditUnit(unit)}
                        className="text-violet-600 hover:text-violet-700 mr-3"
                      >
                        ✏
                      </button>
                      <button
                        onClick={() => handleDeleteUnit(unit.id)}
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
      )}

      {/* Модалки */}
      {workModalOpen && (
        <WorkModal
          work={editingWork}
          onSave={handleSaveWork}
          onClose={() => {
            setWorkModalOpen(false)
            setEditingWork(null)
          }}
        />
      )}

      {materialModalOpen && (
        <MaterialModal
          material={editingMaterial}
          onSave={handleSaveMaterial}
          onClose={() => {
            setMaterialModalOpen(false)
            setEditingMaterial(null)
          }}
        />
      )}

      {sectionModalOpen && (
        <SectionModal
          section={editingSection}
          onSave={handleSaveSection}
          onClose={() => {
            setSectionModalOpen(false)
            setEditingSection(null)
          }}
        />
      )}

      {materialSectionModalOpen && (
        <MaterialSectionModal
          section={editingMaterialSection}
          onSave={handleSaveMaterialSection}
          onClose={() => {
            setMaterialSectionModalOpen(false)
            setEditingMaterialSection(null)
          }}
        />
      )}

      {unitModalOpen && (
        <UnitModal
          unit={editingUnit}
          onSave={handleSaveUnit}
          onClose={() => {
            setUnitModalOpen(false)
            setEditingUnit(null)
          }}
        />
      )}
    </div>
  )
}