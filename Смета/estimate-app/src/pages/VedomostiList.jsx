import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { getVedomosti, deleteVedomost } from '../api/vedomosti'
import { formatMoney, formatDate } from '../utils/format'

export default function VedomostiList() {
  const [vedomosti, setVedomosti] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    load()
  }, [])

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      setVedomosti(await getVedomosti())
    } catch (err) {
      setError('Не вдалося завантажити відомості. Перевірте backend.')
      console.error(err)
    }
    setLoading(false)
  }

  const handleDelete = async (id, title) => {
    if (!window.confirm(`Видалити відомість «${title}»?`)) return
    try {
      await deleteVedomost(id)
      await load()
    } catch (err) {
      alert('Помилка видалення: ' + err.message)
    }
  }

  const calcTotals = (vedomost) => {
    let naryad = 0
    let koshtorys = 0

    vedomost.sections?.forEach((section) => {
      section.items?.forEach((item) => {
        const qty = item.quantity || 0
        naryad += qty * (item.priceWorker || 0)
        koshtorys += qty * (item.priceClient || 0)

        item.materials?.forEach((mat) => {
          naryad += (mat.quantity || 0) * (mat.pricePurchase || 0)
          koshtorys += (mat.quantity || 0) * (mat.priceClient || 0)
        })
      })
    })

    return { naryad, koshtorys, profit: koshtorys - naryad }
  }

  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-800 mb-6">
        Відомості робіт та матеріалів
      </h2>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 p-3 rounded-lg mb-4">
          {error}
        </div>
      )}

      {loading ? (
        <div className="bg-white rounded-lg shadow-sm p-12 text-center text-gray-500">
          Завантаження...
        </div>
      ) : vedomosti.length === 0 ? (
        <div className="bg-white rounded-lg shadow-sm p-12 text-center text-gray-500">
          <p className="text-lg mb-4">У вас поки немає відомостей</p>
          <Link
            to="/vedomosti/new"
            className="inline-block bg-violet-600 text-white px-6 py-2 rounded-lg hover:bg-violet-700"
          >
            Створити першу відомість
          </Link>
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr className="text-left text-gray-600 border-b border-gray-200">
                <th className="px-4 py-3 font-medium">Назва</th>
                <th className="px-4 py-3 font-medium">Об'єкт</th>
                <th className="px-4 py-3 font-medium">Дата</th>
                <th className="px-4 py-3 font-medium text-right">Наряд</th>
                <th className="px-4 py-3 font-medium text-right">Кошторис</th>
                <th className="px-4 py-3 font-medium text-right">Прибуток</th>
                <th className="px-4 py-3 w-24"></th>
              </tr>
            </thead>
            <tbody>
              {vedomosti.map((v) => {
                const totals = calcTotals(v)
                return (
                  <tr key={v.id} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <Link
                        to={`/vedomosti/${v.id}`}
                        className="text-violet-600 hover:underline font-medium"
                      >
                        {v.title}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-gray-600">{v.object || '—'}</td>
                    <td className="px-4 py-3 text-gray-500 text-xs">
                      {formatDate(v.createdAt)}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-800">
                      {formatMoney(totals.naryad)}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-800">
                      {formatMoney(totals.koshtorys)}
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-green-700">
                      {formatMoney(totals.profit)}
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <Link
                        to={`/vedomosti/${v.id}`}
                        className="text-violet-600 hover:text-violet-700 mr-3"
                        title="Редагувати"
                      >
                        ✏
                      </Link>
                      <button
                        onClick={() => handleDelete(v.id, v.title)}
                        className="text-red-500 hover:text-red-700"
                        title="Видалити"
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}