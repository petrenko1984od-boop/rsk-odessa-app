import { useState, useEffect, useRef } from 'react'
import {
  getCompanySettings,
  updateCompanySettings,
  uploadLogo,
  deleteLogo,
} from '../api/companySettings'

export default function SettingsModal({ onClose }) {
  const [form, setForm] = useState({
    companyName: '',
    phone: '',
    email: '',
    website: '',
    address: '',
    defaultNotes: '',
  })
  const [logoUrl, setLogoUrl] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState(null)

  const fileInputRef = useRef(null)

  useEffect(() => {
    load()
  }, [])

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const s = await getCompanySettings()
      setForm({
        companyName: s.companyName || '',
        phone: s.phone || '',
        email: s.email || '',
        website: s.website || '',
        address: s.address || '',
        defaultNotes: s.defaultNotes || '',
      })
      setLogoUrl(s.logoUrl || null)
    } catch (err) {
      setError('Не вдалося завантажити налаштування')
      console.error(err)
    }
    setLoading(false)
  }

  const handleChange = (field, value) => {
    setForm({ ...form, [field]: value })
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await updateCompanySettings(form)
      onClose()
    } catch (err) {
      alert('Помилка збереження: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  const handleLogoUpload = async (e) => {
    const file = e.target.files[0]
    if (!file) return

    setUploading(true)
    try {
      const s = await uploadLogo(file)
      setLogoUrl(s.logoUrl)
    } catch (err) {
      alert('Помилка завантаження: ' + err.message)
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleLogoDelete = async () => {
    if (!window.confirm('Видалити логотип?')) return
    try {
      await deleteLogo()
      setLogoUrl(null)
    } catch (err) {
      alert('Помилка видалення: ' + err.message)
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[70] p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center p-4 border-b border-gray-200 sticky top-0 bg-white">
          <h3 className="text-lg font-semibold text-gray-800">
            Налаштування компанії
          </h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-xl"
          >
            ✕
          </button>
        </div>

        {loading ? (
          <div className="p-8 text-center text-gray-500">Завантаження...</div>
        ) : error ? (
          <div className="p-8 text-center text-red-500">{error}</div>
        ) : (
          <div className="p-4 space-y-4">
            {/* Логотип */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Логотип
              </label>
              <div className="flex items-center gap-4">
                {logoUrl ? (
                  <div className="flex items-center gap-3">
                    <img
                      src={'http://localhost:3001' + logoUrl}
                      alt="Логотип"
                      className="h-16 w-auto border border-gray-200 rounded p-1 bg-white"
                    />
                    <button
                      onClick={handleLogoDelete}
                      className="text-red-500 hover:text-red-700 text-sm"
                    >
                      Видалити
                    </button>
                  </div>
                ) : (
                  <p className="text-sm text-gray-400">Логотип не завантажено</p>
                )}
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  className="text-sm bg-stone-50 text-violet-600 px-3 py-1.5 rounded hover:bg-stone-100 font-medium disabled:opacity-50"
                >
                  {uploading ? 'Завантаження...' : '+ Завантажити'}
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".png,.jpg,.jpeg"
                  onChange={handleLogoUpload}
                  className="hidden"
                />
              </div>
            </div>

            {/* Название */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Назва компанії
              </label>
              <input
                type="text"
                value={form.companyName}
                onChange={(e) => handleChange('companyName', e.target.value)}
                placeholder="ТОВ «Будівельник»"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-violet-500"
              />
            </div>

            {/* Телефон + Email */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Телефон
                </label>
                <input
                  type="text"
                  value={form.phone}
                  onChange={(e) => handleChange('phone', e.target.value)}
                  placeholder="+38 (099) 12-34-567"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-violet-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Email
                </label>
                <input
                  type="email"
                  value={form.email}
                  onChange={(e) => handleChange('email', e.target.value)}
                  placeholder="info@company.ua"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-violet-500"
                />
              </div>
            </div>

            {/* Сайт + Адрес */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Сайт
                </label>
                <input
                  type="text"
                  value={form.website}
                  onChange={(e) => handleChange('website', e.target.value)}
                  placeholder="company.ua"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-violet-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Адреса
                </label>
                <input
                  type="text"
                  value={form.address}
                  onChange={(e) => handleChange('address', e.target.value)}
                  placeholder="м. Київ, вул. Хрещатик, 1"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-violet-500"
                />
              </div>
            </div>

            {/* Примечания по умолчанию */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Примітки за замовчуванням
              </label>
              <textarea
                value={form.defaultNotes}
                onChange={(e) => handleChange('defaultNotes', e.target.value)}
                rows="4"
                placeholder="Ці примітки будуть автоматично додані до кожної нової відомості."
                className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-violet-500"
              />
              <p className="text-xs text-gray-500 mt-1">
                Будуть автоматично підставлені в нові відомості.
              </p>
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
                onClick={handleSave}
                disabled={saving}
                className="bg-violet-600 text-white px-4 py-2 rounded-lg hover:bg-violet-700 disabled:opacity-50"
              >
                {saving ? 'Збереження...' : 'Зберегти'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}