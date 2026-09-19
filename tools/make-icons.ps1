# =====================================================================
# RSK ODESSA — ГЕНЕРАЦИЯ ИКОНОК ПРИЛОЖЕНИЯ (PWA)
# =====================================================================
# Рисует иконки для manifest.json из logo.png в папку icons/:
#
#   icon-192.png, icon-512.png         — обычные иконки: фирменный зелёный фон,
#                                        белая скруглённая плашка, логотип по центру;
#   maskable-192.png, maskable-512.png — «маскабельные» (Android/PWA): логотип
#                                        меньше и внутри безопасной зоны 80 %,
#                                        чтобы круглая маска не обрезала надпись;
#   apple-touch-icon.png               — 180x180 для iPhone и iPad.
#
# Иконок должно быть ровно столько, сколько перечислено в manifest.json,
# иначе браузер откажется предлагать установку приложения.
#
# ЗАПУСК (из корня репозитория, PowerShell):
#   powershell -ExecutionPolicy Bypass -File tools/make-icons.ps1
#
# Требуется .NET GDI+ (System.Drawing) — есть в Windows «из коробки».
# Файл сохранён в UTF-8 с BOM, иначе PowerShell 5.1 испортит русские комментарии.
# =====================================================================

[CmdletBinding()]
param(
    [string]$Source,
    [string]$OutDir
)

Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
if (-not $Source) { $Source = Join-Path $root 'logo.png' }
if (-not $OutDir) { $OutDir = Join-Path $root 'icons' }

if (-not (Test-Path $Source)) { throw "Не найден исходный логотип: $Source" }
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }

# Фирменный зелёный #15803d — тот же цвет, что в теме приложения и манифесте.
$brand = [System.Drawing.Color]::FromArgb(255, 21, 128, 61)

function New-RoundedRectPath {
    param([single]$X, [single]$Y, [single]$W, [single]$H, [single]$R)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $R * 2
    $path.AddArc($X, $Y, $d, $d, 180, 90)
    $path.AddArc($X + $W - $d, $Y, $d, $d, 270, 90)
    $path.AddArc($X + $W - $d, $Y + $H - $d, $d, $d, 0, 90)
    $path.AddArc($X, $Y + $H - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    return $path
}

function Write-Icon {
    param([string]$Path, [int]$Size, [ValidateSet('any', 'maskable')][string]$Kind)

    $logo = [System.Drawing.Image]::FromFile($Source)
    $bmp = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $bmp.SetResolution(96, 96)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)

    try {
        $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $g.Clear($brand)

        if ($Kind -eq 'maskable') {
            # Безопасная зона — окружность диаметром 80 % холста: белый круг и логотип внутри неё.
            $d = [single]($Size * 0.76)
            $x = [single](($Size - $d) / 2)
            $g.FillEllipse($white, $x, $x, $d, $d)
            $logoWidth = [single]($Size * 0.52)
        } else {
            # Скруглённая плашка почти во весь холст + логотип на 84 % её ширины.
            # Внимание: имя переменной не $path — параметр функции $Path имеет тип
            # [string], а в PowerShell имена регистронезависимы (объект стал бы строкой).
            $inset  = [single]($Size * 0.055)
            $plate  = [single]($Size - 2 * $inset)
            $radius = [single]($Size * 0.22)
            $platePath = New-RoundedRectPath -X $inset -Y $inset -W $plate -H $plate -R $radius
            $g.FillPath($white, $platePath)
            $platePath.Dispose()
            $logoWidth = [single]($plate * 0.84)
        }

        # Логотип — по центру, пропорции исходника сохраняем.
        $logoHeight = [single]($logoWidth * $logo.Height / $logo.Width)
        $g.DrawImage($logo,
            [single](($Size - $logoWidth) / 2),
            [single](($Size - $logoHeight) / 2),
            $logoWidth,
            $logoHeight)
    }
    finally {
        $white.Dispose()
        $g.Dispose()
        $logo.Dispose()
    }

    $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()

    $file = Get-Item $Path
    Write-Output ('{0,-22} {1}x{1}  {2} байт' -f $file.Name, $Size, $file.Length)
}

Write-Icon -Path (Join-Path $OutDir 'icon-192.png')          -Size 192 -Kind 'any'
Write-Icon -Path (Join-Path $OutDir 'icon-512.png')          -Size 512 -Kind 'any'
Write-Icon -Path (Join-Path $OutDir 'maskable-192.png')      -Size 192 -Kind 'maskable'
Write-Icon -Path (Join-Path $OutDir 'maskable-512.png')      -Size 512 -Kind 'maskable'
Write-Icon -Path (Join-Path $OutDir 'apple-touch-icon.png')  -Size 180 -Kind 'any'

Write-Output ('Готово. Иконки обновлены в ' + $OutDir)
