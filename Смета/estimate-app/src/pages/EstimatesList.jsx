export default function EstimatesList() {
  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-800 mb-6">Мои сметы</h2>

      <div className="bg-white rounded-lg shadow-sm p-12 text-center text-gray-500">
        <p className="text-lg mb-4">У вас пока нет смет</p>
        <button className="bg-violet-600 text-white px-6 py-2 rounded-lg hover:bg-violet-700">
          Создать первую смету
        </button>
      </div>
    </div>
  )
}