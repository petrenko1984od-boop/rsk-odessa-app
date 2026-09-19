# =====================================================================
# RSK ODESSA — СБОРКА PDF ИЗ ИНСТРУКЦИЙ (папка «Документация»)
# =====================================================================
# Печатает каждый *.html из папки «Документация» в одноимённый *.pdf
# через headless-браузер (Chrome или Edge). Отдельные конвертеры и
# библиотеки не нужны: печатная тема (A4, книжная) лежит в docs.css.
#
# ЗАПУСК (из корня репозитория, PowerShell):
#   powershell -ExecutionPolicy Bypass -File tools/make-docs.ps1
#
# Параметры:
#   -DocsDir  папка с html (по умолчанию <корень>\Документация)
#   -Browser  путь к chrome.exe / msedge.exe (по умолчанию ищется сам)
#   -VirtualTimeBudget  мс на загрузку страницы перед печатью (6000)
#
# Файл сохранён в UTF-8 с BOM, иначе PowerShell 5.1 испортит русские
# комментарии и пути к папке «Документация».
# =====================================================================

[CmdletBinding()]
param(
    [string]$DocsDir,
    [string]$Browser,
    [int]$VirtualTimeBudget = 6000
)

$root = Split-Path -Parent $PSScriptRoot
if (-not $DocsDir) { $DocsDir = Join-Path $root 'Документация' }

if (-not (Test-Path -LiteralPath $DocsDir)) {
    throw "Не найдена папка с инструкциями: $DocsDir"
}

function Find-Browser {
    $candidates = @(
        (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
        (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe'),
        (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe')
    )

    foreach ($path in $candidates) {
        if ($path -and (Test-Path -LiteralPath $path)) { return $path }
    }
    return $null
}

if (-not $Browser) { $Browser = Find-Browser }
if (-not $Browser -or -not (Test-Path -LiteralPath $Browser)) {
    throw 'Не найден Chrome или Edge. Укажите путь: -Browser "C:\путь\chrome.exe"'
}

$files = Get-ChildItem -LiteralPath $DocsDir -Filter '*.html' -File | Sort-Object Name
if ($files.Count -eq 0) { throw "В папке нет html-файлов: $DocsDir" }

Write-Host "Браузер: $Browser"
Write-Host "Документов: $($files.Count)"
Write-Host ''

$failed = @()

foreach ($file in $files) {
    $pdf = [IO.Path]::ChangeExtension($file.FullName, '.pdf')

    # Кириллица и пробелы в пути: передаём браузеру уже процент-кодированный file:///
    $uri = ([System.Uri]$file.FullName).AbsoluteUri

    Write-Host "→ $($file.Name)"
    & $Browser --headless=new --no-pdf-header-footer `
        "--virtual-time-budget=$VirtualTimeBudget" `
        "--print-to-pdf=$pdf" $uri 2>&1 | Out-Null

    if (Test-Path -LiteralPath $pdf) {
        $sizeKb = [math]::Round((Get-Item -LiteralPath $pdf).Length / 1KB)
        Write-Host "   готово: $([IO.Path]::GetFileName($pdf)) ($sizeKb КБ)"
    } else {
        Write-Host '   ОШИБКА: PDF не создан'
        $failed += $file.Name
    }
}

Write-Host ''
if ($failed.Count -gt 0) {
    throw "Не собраны: $($failed -join ', ')"
}
Write-Host "Готово: $($files.Count) PDF в папке $DocsDir"
