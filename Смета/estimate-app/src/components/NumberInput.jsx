import { useState, useEffect, useRef } from 'react'

export default function NumberInput({
  value,
  onChange,
  step = '0.01',
  min = 0,
  placeholder = '',
  className = '',
  disabled = false,
  ...props
}) {
  const [localValue, setLocalValue] = useState('')
  const [isFocused, setIsFocused] = useState(false)
  const inputRef = useRef(null)

  // Синхронизация с внешним value
  useEffect(() => {
    if (!isFocused) {
      // Если не в фокусе — показываем значение (0 или число)
      const num = parseFloat(value)
      if (value === '' || value === null || value === undefined) {
        setLocalValue('')
      } else if (isNaN(num)) {
        setLocalValue('')
      } else {
        setLocalValue(String(value))
      }
    }
  }, [value, isFocused])

  const handleFocus = (e) => {
    setIsFocused(true)
    // При фокусе, если значение 0 или "0" — очищаем
    if (localValue === '0' || parseFloat(localValue) === 0) {
      setLocalValue('')
    }
    // Выделяем текст для удобства
    setTimeout(() => e.target.select(), 0)
  }

  const handleChange = (e) => {
    const newValue = e.target.value
    setLocalValue(newValue)
    // Отправляем родителю число или пустую строку
    if (newValue === '') {
      onChange('')
    } else {
      const num = parseFloat(newValue)
      onChange(isNaN(num) ? '' : num)
    }
  }

  const handleBlur = () => {
    setIsFocused(false)
    // При размытии, если пусто — оставляем пусто (или 0)
    if (localValue === '' || localValue === '-') {
      setLocalValue('')
      onChange('')
    } else {
      const num = parseFloat(localValue)
      if (isNaN(num)) {
        setLocalValue('')
        onChange('')
      } else {
        // Нормализуем значение
        setLocalValue(String(num))
        onChange(num)
      }
    }
  }

  return (
    <input
      ref={inputRef}
      type="number"
      value={localValue}
      onChange={handleChange}
      onFocus={handleFocus}
      onBlur={handleBlur}
      step={step}
      min={min}
      placeholder={placeholder}
      disabled={disabled}
      className={className}
      {...props}
    />
  )
}