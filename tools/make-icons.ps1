# =====================================================================
# FREEDOM — ГЕНЕРАЦИЯ ИКОНОК ПРИЛОЖЕНИЯ (PWA)
# =====================================================================
# Рисует иконки для manifest.json из logo.png (монограмма FD) в папку icons/:
#
#   icon-192.png, icon-512.png         — обычные иконки: фон = фон логотипа,
#                                        знак по центру (70 % ширины иконки);
#   maskable-192.png, maskable-512.png — «маскабельные» (Android/PWA): знак
#                                        мельче (52 %) и внутри безопасной зоны
#                                        80 %, чтобы круглая маска не срезала его;
#   apple-touch-icon.png               — 180x180 для iPhone и iPad.
#
# Логотип не перерисовывается и не «докрашивается»: берётся ровно тот файл,
# что лежит в корне. Поэтому смена логотипа = заменить logo.png (квадратный
# файл, знак на однотонном фоне) и повторить запуск скрипта.
#
# Фон иконки не задан «на глаз»: он берётся пикселем из угла логотипа, а знак
# выравнивается по своим настоящим границам — скрипт сам ищет «чернила»
# (пиксели, отличающиеся от фона). Поэтому у логотипа могут быть любые поля
# вокруг знака, а иконки всё равно выйдут ровными и одинаковыми по размеру
# знака. Так же было и раньше с плашкой, только плашка ставилась чужая —
# теперь иконка это сам фирменный знак.
#
# Иконок должно быть ровно столько, сколько перечислено в manifest.json,
# иначе браузер откажется предлагать установку приложения.
#
# ЗАПУСК (из корня репозитория, PowerShell):
#   powershell -ExecutionPolicy Bypass -File tools/make-icons.ps1
#
# Параметры:
#   -Source  исходный логотип (по умолчанию <корень>\logo.png)
#   -OutDir  куда писать иконки (по умолчанию <корень>\icons)
#   -MarkWidth / -MaskableMarkWidth  доля ширины иконки под знак (0.70 / 0.52)
#
# Требуется .NET GDI+ (System.Drawing) — есть в Windows «из коробки».
# Файл сохранён в UTF-8 с BOM, иначе PowerShell 5.1 испортит русские комментарии.
# =====================================================================

[CmdletBinding()]
param(
    [string]$Source,
    [string]$OutDir,
    [double]$MarkWidth = 0.70,
    [double]$MaskableMarkWidth = 0.52
)

Add-Type -AssemblyName System.Drawing

# Поиск «чернил» на картинке: перебор 600x600 пикселей методом GetPixel в
# PowerShell занимает секунды, поэтому границы знака считает этот маленький
# класс на C# (LockBits + Marshal.Copy — один проход по буферу).
if (-not ('FreedomInkBox' -as [type])) {
    Add-Type -ReferencedAssemblies 'System.Drawing' -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class FreedomInkBox
{
    // Возвращает {x, y, width, height} прямоугольника, в котором есть пиксели,
    // отличающиеся от фона (левый верхний пиксель) больше чем на tolerance.
    public static int[] Find(Bitmap bmp, int tolerance)
    {
        int w = bmp.Width;
        int h = bmp.Height;
        BitmapData data = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
        try
        {
            byte[] buffer = new byte[data.Stride * h];
            Marshal.Copy(data.Scan0, buffer, 0, buffer.Length);

            int b0 = buffer[0];
            int g0 = buffer[1];
            int r0 = buffer[2];

            int minX = w, minY = h, maxX = -1, maxY = -1;
            for (int y = 0; y < h; y++)
            {
                int row = y * data.Stride;
                for (int x = 0; x < w; x++)
                {
                    int i = row + x * 3;
                    int diff = Math.Abs(buffer[i] - b0) + Math.Abs(buffer[i + 1] - g0) + Math.Abs(buffer[i + 2] - r0);
                    if (diff > tolerance)
                    {
                        if (x < minX) minX = x;
                        if (x > maxX) maxX = x;
                        if (y < minY) minY = y;
                        if (y > maxY) maxY = y;
                    }
                }
            }

            if (maxX < 0) return new int[] { 0, 0, w, h };
            return new int[] { minX, minY, maxX - minX + 1, maxY - minY + 1 };
        }
        finally
        {
            bmp.UnlockBits(data);
        }
    }
}
'@
}

$root = Split-Path -Parent $PSScriptRoot
if (-not $Source) { $Source = Join-Path $root 'logo.png' }
if (-not $OutDir) { $OutDir = Join-Path $root 'icons' }

if (-not (Test-Path $Source)) { throw "Не найден исходный логотип: $Source" }
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }

# Логотип читаем в память: файл на диске остаётся незаблокированным.
$sourceBitmap = New-Object System.Drawing.Bitmap($Source)

# Иконки рисуем из 24-битной копии: у неё предсказуемый формат буфера для
# поиска границ знака (у PNG с прозрачностью формат другой).
if ($sourceBitmap.PixelFormat -ne [System.Drawing.Imaging.PixelFormat]::Format24bppRgb) {
    $normalized = New-Object System.Drawing.Bitmap($sourceBitmap.Width, $sourceBitmap.Height,
        [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $normalizeGraphics = [System.Drawing.Graphics]::FromImage($normalized)
    $normalizeGraphics.DrawImage($sourceBitmap, 0, 0, $sourceBitmap.Width, $sourceBitmap.Height)
    $normalizeGraphics.Dispose()
    $sourceBitmap.Dispose()
    $sourceBitmap = $normalized
}

# Фон иконки = фон логотипа (пиксель из угла). Если угол прозрачный, берём белый.
$bgPixel = $sourceBitmap.GetPixel(0, 0)
if ($bgPixel.A -lt 8) { $bgPixel = [System.Drawing.Color]::White }
$background = [System.Drawing.Color]::FromArgb(255, $bgPixel.R, $bgPixel.G, $bgPixel.B)

# Границы знака внутри логотипа: по ним он центрируется, как бы ни были обрезаны
# поля вокруг (порог 40 — заметно отличается от фона, шум PNG не ловим).
$ink = [FreedomInkBox]::Find($sourceBitmap, 40)
$inkX = $ink[0]; $inkY = $ink[1]; $inkWidth = $ink[2]; $inkHeight = $ink[3]

if ($inkWidth -le 0 -or $inkHeight -le 0) {
    throw "В логотипе не найден знак: $Source — нужен квадратный файл с рисунком на однотонном фоне"
}

$backgroundHex = '#{0:x2}{1:x2}{2:x2}' -f $background.R, $background.G, $background.B
Write-Host "Логотип: $Source ($($sourceBitmap.Width)x$($sourceBitmap.Height))"
Write-Host "Фон иконок: $backgroundHex · знак: $inkWidth x $inkHeight в точке ($inkX, $inkY)"
Write-Host ''

function Write-Icon {
    param([string]$Path, [int]$Size, [ValidateSet('any', 'maskable')][string]$Kind)

    $bmp = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $bmp.SetResolution(96, 96)
    $g = [System.Drawing.Graphics]::FromImage($bmp)

    try {
        $g.SmoothingMode      = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $g.InterpolationMode  = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.PixelOffsetMode    = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality

        # Весь холст — цветом фона логотипа; знак кладём поверх.
        $g.Clear($background)

        # Какая доля ширины иконки приходится на знак: у maskable-иконок меньше,
        # чтобы круг маски (80 % холста) не задел знак.
        $markShare = if ($Kind -eq 'maskable') { $MaskableMarkWidth } else { $MarkWidth }

        # Масштаб логотипа подбираем по знаку, а не по файлу целиком, и сдвигаем
        # так, чтобы центр знака совпал с центром иконки.
        $scale = ($Size * $markShare) / $inkWidth
        $destX = $Size / 2 - ($inkX + $inkWidth / 2) * $scale
        $destY = $Size / 2 - ($inkY + $inkHeight / 2) * $scale

        $g.DrawImage($sourceBitmap,
            [single]$destX,
            [single]$destY,
            [single]($sourceBitmap.Width * $scale),
            [single]($sourceBitmap.Height * $scale))
    }
    finally {
        $g.Dispose()
    }

    $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()

    $file = Get-Item $Path
    Write-Output ('{0,-22} {1}x{1}  {2} байт' -f $file.Name, $Size, $file.Length)
}

Write-Icon -Path (Join-Path $OutDir 'icon-192.png')         -Size 192 -Kind 'any'
Write-Icon -Path (Join-Path $OutDir 'icon-512.png')         -Size 512 -Kind 'any'
Write-Icon -Path (Join-Path $OutDir 'maskable-192.png')     -Size 192 -Kind 'maskable'
Write-Icon -Path (Join-Path $OutDir 'maskable-512.png')     -Size 512 -Kind 'maskable'
Write-Icon -Path (Join-Path $OutDir 'apple-touch-icon.png') -Size 180 -Kind 'any'

$sourceBitmap.Dispose()

Write-Output ('Готово. Иконки обновлены в ' + $OutDir)
