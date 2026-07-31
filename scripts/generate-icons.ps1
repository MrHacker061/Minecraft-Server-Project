$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class EmberHostIconNative {
  [DllImport("user32.dll", CharSet = CharSet.Auto)]
  public static extern bool DestroyIcon(IntPtr handle);
}
'@

$outputDirectory = Join-Path $PSScriptRoot '..\build'
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null

function New-RoundedPath([float]$x, [float]$y, [float]$width, [float]$height, [float]$radius) {
  $diameter = $radius * 2
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc($x, $y, $diameter, $diameter, 180, 90)
  $path.AddArc($x + $width - $diameter, $y, $diameter, $diameter, 270, 90)
  $path.AddArc($x + $width - $diameter, $y + $height - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($x, $y + $height - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

$canvas = New-Object System.Drawing.Bitmap 512, 512, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [System.Drawing.Graphics]::FromImage($canvas)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$graphics.Clear([System.Drawing.Color]::Transparent)

$shape = New-RoundedPath 28 28 456 456 100
$gradient = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.Point 58, 42),
  (New-Object System.Drawing.Point 450, 470),
  ([System.Drawing.ColorTranslator]::FromHtml('#77e093')),
  ([System.Drawing.ColorTranslator]::FromHtml('#43ad63'))
)
$graphics.FillPath($gradient, $shape)

$pixelBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(35, 13, 21, 18))
$graphics.FillRectangle($pixelBrush, 381, 83, 44, 44)
$graphics.FillRectangle($pixelBrush, 86, 388, 34, 34)
$graphics.FillRectangle($pixelBrush, 413, 358, 22, 22)

$font = New-Object System.Drawing.Font 'Segoe UI', 244, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
$textBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#0d1512'))
$format = New-Object System.Drawing.StringFormat
$format.Alignment = [System.Drawing.StringAlignment]::Center
$format.LineAlignment = [System.Drawing.StringAlignment]::Center
$graphics.DrawString('E', $font, $textBrush, (New-Object System.Drawing.RectangleF 31, 12, 450, 472), $format)

$pngPath = Join-Path $outputDirectory 'icon.png'
$canvas.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)

$small = New-Object System.Drawing.Bitmap $canvas, 256, 256
$iconHandle = $small.GetHicon()
$icon = [System.Drawing.Icon]::FromHandle($iconHandle)
$iconPath = Join-Path $outputDirectory 'icon.ico'
$stream = [System.IO.File]::Open($iconPath, [System.IO.FileMode]::Create)
$icon.Save($stream)
$stream.Close()
[EmberHostIconNative]::DestroyIcon($iconHandle) | Out-Null

$icon.Dispose()
$small.Dispose()
$format.Dispose()
$font.Dispose()
$textBrush.Dispose()
$pixelBrush.Dispose()
$gradient.Dispose()
$shape.Dispose()
$graphics.Dispose()
$canvas.Dispose()

Write-Output "Generated $pngPath and $iconPath"
