$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$iconRoot = Join-Path $PSScriptRoot '..\public\icons'
New-Item -ItemType Directory -Path $iconRoot -Force | Out-Null
$source = [System.Drawing.Bitmap]::new(256, 256)
$canvas = [System.Drawing.Graphics]::FromImage($source)
$canvas.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$canvas.Clear([System.Drawing.Color]::Transparent)
$shape = [System.Drawing.Drawing2D.GraphicsPath]::new()
$shape.AddArc(4, 4, 80, 80, 180, 90)
$shape.AddArc(172, 4, 80, 80, 270, 90)
$shape.AddArc(172, 172, 80, 80, 0, 90)
$shape.AddArc(4, 172, 80, 80, 90, 90)
$shape.CloseFigure()
$blue = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(53, 108, 228))
$canvas.FillPath($blue, $shape)
$line = [System.Drawing.Pen]::new([System.Drawing.Color]::White, 15)
$line.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$line.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$canvas.DrawLine($line, 62, 73, 191, 73)
$canvas.DrawLine($line, 62, 128, 130, 128)
$canvas.DrawLine($line, 62, 183, 130, 183)
$triangle = [System.Drawing.PointF[]]@([System.Drawing.PointF]::new(173, 120), [System.Drawing.PointF]::new(213, 155), [System.Drawing.PointF]::new(173, 190))
$canvas.FillPolygon([System.Drawing.Brushes]::White, $triangle)
foreach ($size in @(16, 32, 48, 128)) {
  $output = [System.Drawing.Bitmap]::new($size, $size)
  $graphics = [System.Drawing.Graphics]::FromImage($output)
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.DrawImage($source, 0, 0, $size, $size)
  $output.Save((Join-Path $iconRoot "$size.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $graphics.Dispose()
  $output.Dispose()
}
$line.Dispose()
$blue.Dispose()
$shape.Dispose()
$canvas.Dispose()
$source.Dispose()
Write-Output 'Generated extension icons: 16, 32, 48, 128.'
