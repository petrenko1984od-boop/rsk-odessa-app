import { Link, Outlet, useLocation } from 'react-router-dom'
import { useState } from 'react'
import {
  FileText,
  Users,
  BookOpen,
  Settings,
  Plus,
  Sparkles,
  Command,
} from 'lucide-react'
import SettingsModal from './SettingsModal'

export default function Layout() {
  const location = useLocation()
  const [settingsOpen, setSettingsOpen] = useState(false)

  const isActive = (path) => {
    if (path === '/')
      return (
        location.pathname === '/' ||
        location.pathname.startsWith('/vedomosti')
      )
    return location.pathname.startsWith(path)
  }

  const navItems = [
    { path: '/', label: 'Відомості', icon: FileText },
    { path: '/clients', label: 'Клієнти', icon: Users },
    { path: '/catalog', label: 'Довідники', icon: BookOpen },
  ]

  return (
    <div className="min-h-screen bg-stone-50">
      {/* Хедер */}
      <header className="sticky top-0 z-30 glass border-b border-stone-200/60">
        <div className="max-w-[1600px] mx-auto px-6 py-3 flex justify-between items-center">
          <Link to="/" className="flex items-center gap-3 group">
            {/* Логотип */}
            <div className="relative">
              <div className="absolute inset-0 bg-gradient-to-br from-violet-500 to-violet-700 rounded-xl blur-md opacity-40 group-hover:opacity-70 transition-opacity duration-300" />
              <div className="relative w-10 h-10 bg-gradient-to-br from-violet-500 to-violet-700 rounded-xl flex items-center justify-center shadow-lg shadow-violet-500/30">
                <Sparkles
                  className="w-5 h-5 text-white"
                  strokeWidth={2.5}
                  fill="white"
                />
              </div>
            </div>
            <div>
              <div className="text-[17px] font-bold text-stone-900 tracking-tight leading-tight">
                СметаPRO
              </div>
              <div className="flex items-center gap-1 text-[10px] uppercase tracking-[0.15em] text-violet-600 font-semibold">
                Premium
              </div>
            </div>
          </Link>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setSettingsOpen(true)}
              className="flex items-center gap-2 px-3.5 py-2 rounded-lg text-stone-600 hover:text-violet-700 hover:bg-violet-50 transition-all duration-200"
              title="Налаштування компанії"
            >
              <Settings className="w-4 h-4" strokeWidth={2} />
              <span className="text-sm font-medium">Налаштування</span>
            </button>

            <Link
              to="/vedomosti/new"
              className="group flex items-center gap-2 px-4 py-2 bg-gradient-to-br from-violet-500 to-violet-700 text-white rounded-lg transition-all duration-200 shadow-md shadow-violet-500/25 hover:shadow-glow-lg hover:-translate-y-0.5"
            >
              <Plus className="w-4 h-4" strokeWidth={2.5} />
              <span className="text-sm font-semibold">Створити відомість</span>
            </Link>
          </div>
        </div>
      </header>

      <div className="flex max-w-[1600px] mx-auto">
        {/* Бокове меню */}
        <aside className="w-64 min-h-[calc(100vh-64px)] p-4">
          <nav className="space-y-1">
            {navItems.map((item) => {
              const Icon = item.icon
              const active = isActive(item.path)
              return (
                <Link
                  key={item.path}
                  to={item.path}
                  className={`relative flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium transition-all duration-200 group ${
                    active
                      ? 'bg-white text-stone-900 shadow-premium border border-stone-200/60'
                      : 'text-stone-600 hover:bg-white/70 hover:text-stone-900'
                  }`}
                >
                  {active && (
                    <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-6 bg-gradient-to-b from-violet-500 to-violet-700 rounded-r-full" />
                  )}
                  <div
                    className={`flex items-center justify-center w-7 h-7 rounded-lg transition-all duration-200 ${
                      active
                        ? 'bg-gradient-to-br from-violet-500 to-violet-700 text-white shadow-sm shadow-violet-500/30'
                        : 'bg-stone-100 text-stone-500 group-hover:bg-stone-200'
                    }`}
                  >
                    <Icon className="w-4 h-4" strokeWidth={2.2} />
                  </div>
                  <span className="flex-1">{item.label}</span>
                  {active && (
                    <Command
                      className="w-3.5 h-3.5 text-violet-400 opacity-0 group-hover:opacity-100 transition-opacity"
                      strokeWidth={2.5}
                    />
                  )}
                </Link>
              )
            })}
          </nav>

          {/* Інформаційний блок */}
          <div className="mt-6 relative overflow-hidden p-4 rounded-2xl bg-gradient-to-br from-violet-600 via-violet-700 to-violet-900 text-white shadow-premium-lg">
            {/* Декоративный блик */}
            <div className="absolute -top-8 -right-8 w-24 h-24 bg-violet-400/30 rounded-full blur-2xl" />
            <div className="absolute -bottom-6 -left-6 w-20 h-20 bg-violet-500/20 rounded-full blur-xl" />

            <div className="relative">
              <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.15em] text-violet-200 mb-2">
                <Sparkles className="w-3 h-3" strokeWidth={2.5} />
                Порада дня
              </div>
              <div className="text-sm leading-relaxed text-violet-50">
                Використовуйте розділи довідників, щоб швидко знаходити
                потрібні роботи та матеріали.
              </div>
            </div>
          </div>
        </aside>

        {/* Контент сторінки */}
        <main className="flex-1 p-6 min-w-0">
          <Outlet />
        </main>
      </div>

      {/* Модалка налаштувань */}
      {settingsOpen && (
        <SettingsModal onClose={() => setSettingsOpen(false)} />
      )}
    </div>
  )
}