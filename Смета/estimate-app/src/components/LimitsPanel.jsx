import { useState } from 'react'
import { formatMoney } from '../utils/format'

const PRESET_NAMES = [
  'Непередбачені витрати та витрати',
  'Інфляційна складова (резерв на удорожчання)',
  'Витрати на утримання тимчасових будівель і споруд',
  'Транспортні витрати',
  'Коефіцієнт стисненості умов будівництва',
  'Зимове удорожчання будівництва',
  'Авторський нагляд',
  'Технічний нагляд',
  'Кошторисний прибуток',
  'Комісія генерального підрядника',
]

const CUSTOM_VALUE = '__custom__'

const BASE_OPTIONS = [
  { value: 'works', label: 'від робіт' },
  { value: 'materials', label: 'від матеріалів' },
  { value: 'both', label: 'від робіт і матеріалів' },
]

const EMPTY_LIMIT = {
  name: '',
  isCustom: false,
  percent: 0,
  base: 'both',
}

export default function LimitsPanel({
  limits,
  onChange,
  vatPercent,
  vatBase,
  onVatChange,
  workSum,
  matSum,
}) {
  const calcAmount = (percent, base) => {
    const p = parseFloat(percent) || 0
    if (p <= 0) return 0
    if (base === 'works') return workSum * (p / 100)
    if (base === 'materials') return matSum * (p / 100)
    return (workSum + matSum) * (p / 100)
  }

  // --- Лимиты ---
  const addLimit = () => {
    onChange([...limits, { ...EMPTY_LIMIT }])
  }

  const removeLimit = (idx) => {
    onChange(limits.filter((_, i) => i !== idx))
  }

  const updateLimit = (idx, updates) => {
    onChange(limits.map((lim, i) => (i === idx ? { ...lim, ...updates } : lim)))
  }

  const handleNameSelect = (idx, value) => {
    if (value === CUSTOM_VALUE) {
      updateLimit(idx, { isCustom: true, name: '' })
    } else {
      updateLimit(idx, { isCustom: false, name: value })
    }
  }

  // Итог лимитов (только для расчёта суммы в строке)
  const limitsTotal = limits.reduce(
    (sum, lim) => sum + calcAmount(lim.percent, lim.base),
    0
  )
  const subTotal = workSum + matSum + limitsTotal

  // НДС от подытога
  const vatAmount =
    parseFloat(vatPercent) > 0 ? subTotal * (parseFloat(vatPercent) / 100) : 0

  return (
    <div className="bg-white rounded-lg shadow-sm p-6 mb-6">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-lg font-semibold text-gray-800">
          Лімітовані витрати та ПДВ
        </h3>
        <button
          type="button"
          onClick={addLimit}
          className="text-sm bg-violet-50 text-violet-600 px-3 py-1.5 rounded hover:bg-violet-100 font-medium"
        >
          + Додати лімітовану витрату
        </button>
      </div>

      {limits.length === 0 ? (
        <p className="text-sm text-gray-500 py-3">
          Немає лімітованих витрат. Натисніть «+ Додати лімітовану витрату».
        </p>
      ) : (
        <div className="space-y-2">
          {limits.map((lim, idx) => {
            const amount = calcAmount(lim.percent, lim.base)
            return (
              <div
                key={idx}
                className="grid grid-cols-12 gap-2 items-center border border-gray-200 rounded-lg p-2 bg-gray-50"
              >
                {/* Назва */}
                <div className="col-span-5">
                  {lim.isCustom ? (
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={lim.name}
                        onChange={(e) =>
                          updateLimit(idx, { name: e.target.value })
                        }
                        placeholder="Своя назва витрати"
                        autoFocus
                        className="flex-1 border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:border-violet-500 bg-white"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          updateLimit(idx, { isCustom: false, name: '' })
                        }
                        className="text-xs text-gray-500 hover:text-gray-700"
                        title="Обрати зі списку"
                      >
                        ↩
                      </button>
                    </div>
                  ) : (
                    <select
                      value={lim.name || ''}
                      onChange={(e) => handleNameSelect(idx, e.target.value)}
                      className="w-full border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:border-violet-500 bg-white"
                    >
                      <option value="">— Оберіть витрату —</option>
                      {PRESET_NAMES.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                      <option value={CUSTOM_VALUE}>✏ Свій варіант...</option>
                    </select>
                  )}
                </div>

                {/* % */}
                <div className="col-span-2">
                  <div className="relative">
                    <input
                      type="number"
                      value={lim.percent}
                      onChange={(e) =>
                        updateLimit(idx, { percent: e.target.value })
                      }
                      step="0.01"
                      min="0"
                      placeholder="0"
                      className="w-full border border-gray-300 rounded px-2 py-1 pr-6 text-sm focus:outline-none focus:border-violet-500 bg-white"
                    />
                    <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-400">
                      %
                    </span>
                  </div>
                </div>

                {/* База */}
                <div className="col-span-3">
                  <select
                    value={lim.base || 'both'}
                    onChange={(e) => updateLimit(idx, { base: e.target.value })}
                    className="w-full border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:border-violet-500 bg-white"
                  >
                    {BASE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Сумма */}
                <div className="col-span-1 text-right text-sm font-medium text-gray-700 whitespace-nowrap">
                  {formatMoney(amount)}
                </div>

                {/* Удалить */}
                <div className="col-span-1 text-center">
                  <button
                    type="button"
                    onClick={() => removeLimit(idx)}
                    className="text-red-500 hover:text-red-700 text-sm"
                    title="Видалити"
                  >
                    ✕
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* НДС — фиксированная строка */}
      <div className="mt-6 pt-4 border-t border-gray-200">
        <div className="grid grid-cols-12 gap-2 items-center bg-yellow-50 rounded-lg p-2 border border-yellow-200">
          <div className="col-span-5 font-medium text-gray-800 text-sm pl-2">
            ПДВ (податок на додану вартість)
          </div>
          <div className="col-span-2">
            <div className="relative">
              <input
                type="number"
                value={vatPercent}
                onChange={(e) => onVatChange('vatPercent', e.target.value)}
                step="0.01"
                min="0"
                placeholder="0"
                className="w-full border border-gray-300 rounded px-2 py-1 pr-6 text-sm focus:outline-none focus:border-violet-500 bg-white"
              />
              <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-400">
                %
              </span>
            </div>
          </div>
          <div className="col-span-3">
            <select
              value={vatBase || 'both'}
              onChange={(e) => onVatChange('vatBase', e.target.value)}
              className="w-full border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:border-violet-500 bg-white"
            >
              {BASE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          <div className="col-span-1 text-right text-sm font-medium text-gray-700 whitespace-nowrap">
            {formatMoney(vatAmount)}
          </div>
          <div className="col-span-1"></div>
        </div>
      </div>
    </div>
  )
}