import { useState, useRef, useEffect } from 'react'
import { openPdf } from '../api/pdf'

export default function PrintMenu({ vedomostId, disabled }) {
  const [open, setOpen] = useState(false)
  const menuRef = useRef(null)

  useEffect(() => {
    const handleClick = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const handleSelect = (type) => {
    setOpen(false)
    openPdf(vedomostId, type)
  }

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setOpen(!open)}
        disabled={disabled}
        className="bg-green-600 text-white px-6 py-2 rounded-lg hover:bg-green-700 disabled:opacity-50 flex items-center gap-2"
      >
        🖨 Сформувати
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-72 bg-white rounded-lg shadow-xl border border-gray-200 z-30">
          <button
            onClick={() => handleSelect('koshtorys')}
            className="w-full text-left px-4 py-3 hover:bg-stone-100 border-b border-gray-100"
          >
            <div className="font-medium text-gray-800">
              🖨 Простий кошторис
            </div>
            <div className="text-xs text-gray-500 mt-0.5">
              6-ти графка (книжна орієнтація)
            </div>
          </button>

          <button
            onClick={() => handleSelect('9graph')}
            className="w-full text-left px-4 py-3 hover:bg-stone-100 border-b border-gray-100"
          >
            <div className="font-medium text-gray-800">
              🖨 Розширений кошторис
            </div>
            <div className="text-xs text-gray-500 mt-0.5">
              9-ти графка (альбомна орієнтація)
            </div>
          </button>

          <button
            onClick={() => handleSelect('naryad')}
            className="w-full text-left px-4 py-3 hover:bg-stone-100 border-b border-gray-100"
          >
            <div className="font-medium text-gray-800">
              🖨 Наряд робітникам
            </div>
            <div className="text-xs text-gray-500 mt-0.5">
              Тільки роботи за нарядними цінами
            </div>
          </button>

          <button
            onClick={() => handleSelect('zakupivlya')}
            className="w-full text-left px-4 py-3 hover:bg-stone-100"
          >
            <div className="font-medium text-gray-800">
              🖨 Заявка постачальнику
            </div>
            <div className="text-xs text-gray-500 mt-0.5">
              Тільки матеріали за закупівельними цінами
            </div>
          </button>
        </div>
      )}
    </div>
  )
}