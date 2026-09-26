import { useState, useEffect } from 'react'
import { Users, Plus, Pencil, Trash2, Phone, Mail, MapPin } from 'lucide-react'
import {
  getClients,
  createClient,
  updateClient,
  deleteClient,
} from '../api/clients'
import ClientModal from '../components/ClientModal'

export default function Clients() {
  const [clients, setClients] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [modalOpen, setModalOpen] = useState(false)
  const [editingClient, setEditingClient] = useState(null)

  useEffect(() => {
    load()
  }, [])

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      setClients(await getClients())
    } catch (err) {
      setError('Не вдалося завантажити клієнтів. Перевірте backend.')
      console.error(err)
    }
    setLoading(false)
  }

  const openNew = () => {
    setEditingClient(null)
    setModalOpen(true)
  }

  const openEdit = (client) => {
    setEditingClient(client)
    setModalOpen(true)
  }

  const handleSave = async (data) => {
    try {
      if (editingClient) {
        await updateClient(editingClient.id, data)
      } else {
        await createClient(data)
      }
      setModalOpen(false)
      setEditingClient(null)
      await load()
    } catch (err) {
      alert('Помилка збереження: ' + err.message)
    }
  }

  const handleDelete = async (client) => {
    if (
      !window.confirm(
        `Видалити клієнта «${client.name}»?\nЦю дію не можна скасувати.`
      )
    )
      return
    try {
      await deleteClient(client.id)
      await load()
    } catch (err) {
      alert('Помилка видалення: ' + err.message)
    }
  }

  return (
    <div>
      {/* Заголовок */}
      <div className="flex justify-between items-end mb-6">
        <div>
          <h1 className="text-3xl font-bold text-stone-900 tracking-tight mb-1">
            Клієнти
          </h1>
          <p className="text-sm text-stone-500">
            База замовників для ваших відомостей
          </p>
        </div>
        <button
          onClick={openNew}
          className="flex items-center gap-2 bg-gradient-to-br from-violet-500 to-violet-700 text-white px-5 py-2.5 rounded-xl font-semibold transition-all shadow-md shadow-violet-500/25 hover:shadow-glow-lg hover:-translate-y-0.5"
        >
          <Plus className="w-4 h-4" strokeWidth={2.5} />
          Додати клієнта
        </button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 p-4 rounded-xl mb-4 text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <div className="bg-white rounded-2xl border border-stone-200/60 p-12 text-center text-stone-500">
          Завантаження...
        </div>
      ) : clients.length === 0 ? (
        <div className="bg-white rounded-2xl border border-dashed border-stone-300 p-16 text-center animate-fade-in">
          <div className="w-20 h-20 mx-auto mb-6 rounded-2xl bg-gradient-to-br from-violet-100 to-violet-50 flex items-center justify-center">
            <Users className="w-10 h-10 text-violet-500" strokeWidth={1.8} />
          </div>
          <h3 className="text-xl font-bold text-stone-900 mb-2">
            Ще немає клієнтів
          </h3>
          <p className="text-sm text-stone-500 mb-6 max-w-md mx-auto">
            Додайте першого клієнта, щоб прив'язувати до нього відомості
          </p>
          <button
            onClick={openNew}
            className="inline-flex items-center gap-2 bg-gradient-to-br from-violet-500 to-violet-700 text-white px-6 py-3 rounded-xl font-semibold transition-all shadow-md shadow-violet-500/25 hover:shadow-glow-lg hover:-translate-y-0.5"
          >
            <Plus className="w-4 h-4" strokeWidth={2.5} />
            Додати першого клієнта
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {clients.map((client, index) => (
            <div
              key={client.id}
              style={{ animationDelay: `${index * 30}ms` }}
              className="group relative bg-white rounded-2xl border border-stone-200/60 p-5 hover:border-violet-300 hover:shadow-premium-lg transition-all duration-300 animate-fade-in hover:-translate-y-1"
            >
              {/* Аватар + имя */}
              <div className="flex items-start gap-3 mb-4">
                <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-violet-500 to-violet-700 flex items-center justify-center text-white font-bold text-lg shadow-sm shadow-violet-500/25 shrink-0">
                  {client.name.charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-bold text-stone-900 truncate">
                    {client.name}
                  </div>
                  <div className="text-xs text-stone-400 mt-0.5">
                    Відомостей: {client._count?.vedomosti || 0}
                  </div>
                </div>
              </div>

              {/* Контакты */}
              <div className="space-y-1.5 text-xs text-stone-600">
                {client.phone && (
                  <div className="flex items-center gap-2">
                    <Phone className="w-3.5 h-3.5 text-stone-400" strokeWidth={2} />
                    <span className="truncate">{client.phone}</span>
                  </div>
                )}
                {client.email && (
                  <div className="flex items-center gap-2">
                    <Mail className="w-3.5 h-3.5 text-stone-400" strokeWidth={2} />
                    <span className="truncate">{client.email}</span>
                  </div>
                )}
                {client.address && (
                  <div className="flex items-center gap-2">
                    <MapPin className="w-3.5 h-3.5 text-stone-400" strokeWidth={2} />
                    <span className="truncate">{client.address}</span>
                  </div>
                )}
                {!client.phone && !client.email && !client.address && (
                  <div className="text-stone-400 italic">
                    Контактів не додано
                  </div>
                )}
              </div>

              {/* Кнопки */}
              <div className="absolute top-3 right-3 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  onClick={() => openEdit(client)}
                  className="w-7 h-7 rounded-lg bg-stone-100 hover:bg-violet-100 hover:text-violet-700 text-stone-500 flex items-center justify-center transition-colors"
                  title="Редагувати"
                >
                  <Pencil className="w-3.5 h-3.5" strokeWidth={2.2} />
                </button>
                <button
                  onClick={() => handleDelete(client)}
                  className="w-7 h-7 rounded-lg bg-stone-100 hover:bg-red-100 hover:text-red-600 text-stone-500 flex items-center justify-center transition-colors"
                  title="Видалити"
                >
                  <Trash2 className="w-3.5 h-3.5" strokeWidth={2.2} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {modalOpen && (
        <ClientModal
          client={editingClient}
          onSave={handleSave}
          onClose={() => {
            setModalOpen(false)
            setEditingClient(null)
          }}
        />
      )}
    </div>
  )
}