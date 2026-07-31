$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

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

$innerBorder = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(90, 196, 255, 211)), 3
$graphics.DrawPath($innerBorder, $shape)

$orbitPen = New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml('#0b1811')), 24
foreach ($angle in @(0, 60, 120)) {
  $state = $graphics.Save()
  $graphics.TranslateTransform(256, 256)
  $graphics.RotateTransform($angle)
  $graphics.DrawEllipse($orbitPen, -142, -58, 284, 116)
  $graphics.Restore($state)
}
$coreBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#0b1811'))
$graphics.FillEllipse($coreBrush, 231, 231, 50, 50)

$pngPath = Join-Path $outputDirectory 'icon.png'
$canvas.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)

$iconPath = Join-Path $outputDirectory 'icon.ico'
$iconSizes = @(16, 24, 32, 48, 64, 128, 256)
$frames = @()
foreach ($size in $iconSizes) {
  $frame = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $frameGraphics = [System.Drawing.Graphics]::FromImage($frame)
  $frameGraphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
  $frameGraphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $frameGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $frameGraphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $frameGraphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $frameGraphics.DrawImage($canvas, 0, 0, $size, $size)
  $memory = New-Object System.IO.MemoryStream
  $frame.Save($memory, [System.Drawing.Imaging.ImageFormat]::Png)
  $frames += ,$memory.ToArray()
  $memory.Dispose()
  $frameGraphics.Dispose()
  $frame.Dispose()
}

$stream = [System.IO.File]::Open($iconPath, [System.IO.FileMode]::Create)
$writer = New-Object System.IO.BinaryWriter $stream
$writer.Write([UInt16]0)
$writer.Write([UInt16]1)
$writer.Write([UInt16]$iconSizes.Count)
$offset = 6 + 16 * $iconSizes.Count
for ($index = 0; $index -lt $iconSizes.Count; $index++) {
  $size = $iconSizes[$index]
  $bytes = $frames[$index]
  $writer.Write([byte]$(if ($size -eq 256) { 0 } else { $size }))
  $writer.Write([byte]$(if ($size -eq 256) { 0 } else { $size }))
  $writer.Write([byte]0)
  $writer.Write([byte]0)
  $writer.Write([UInt16]1)
  $writer.Write([UInt16]32)
  $writer.Write([UInt32]$bytes.Length)
  $writer.Write([UInt32]$offset)
  $offset += $bytes.Length
}
foreach ($bytes in $frames) { $writer.Write([byte[]]$bytes) }
$writer.Dispose()
$stream.Dispose()

$coreBrush.Dispose()
$orbitPen.Dispose()
$innerBorder.Dispose()
$gradient.Dispose()
$shape.Dispose()
$graphics.Dispose()
$canvas.Dispose()

Write-Output "Generated $pngPath and $iconPath"
