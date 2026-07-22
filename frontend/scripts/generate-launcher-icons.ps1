<#
    Regenerates the Android launcher PNGs: the CityShield mark centred on a
    white background.

    These are the *legacy* icons, used on API 24-25 only. API 26+ takes the
    adaptive icon in res/mipmap-anydpi-v26/, whose foreground is a vector and
    needs no rasterising. Both mirror frontend/assets/logo-mark.svg — change
    the geometry there first, then here.

    The mark is redrawn with System.Drawing rather than rasterised from the
    SVG because nothing in this toolchain can read an SVG, and the artwork is
    a handful of primitives: two quadratic-cornered outlines, a rounded rect,
    a circle and two arcs.

    Usage:  powershell -ExecutionPolicy Bypass -File scripts/generate-launcher-icons.ps1
#>

Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = 'Stop'

$resDir = Join-Path $PSScriptRoot '..\android\app\src\main\res'

# Brand blue = theme.ts `lightColors.primary`. The mark is always drawn on
# white here, so it takes the light-theme value even though the in-app logo
# component follows the active palette.
$brand = [System.Drawing.Color]::FromArgb(0x1A, 0x56, 0xDB)

# Launcher icon is 48dp; these are the five density buckets.
$densities = @{
    'mipmap-mdpi'    = 48
    'mipmap-hdpi'    = 72
    'mipmap-xhdpi'   = 96
    'mipmap-xxhdpi'  = 144
    'mipmap-xxxhdpi' = 192
}

# Rendered at this multiple then downsampled — System.Drawing's own
# anti-aliasing alone leaves the shield tip and the wave caps visibly ragged
# at 48px.
$supersample = 8

# ── Geometry, in the 128x128 viewport of logo-mark.svg ──────────────────────
# Shield bounding box, used to centre and scale the mark.
$markCx = 64.0
$markCy = 64.5   # shield spans y 8..121
$markH  = 113.0

# Fraction of the canvas the shield's height occupies.
$logoScale = 0.62
# Corner rounding of the square icon, as a fraction of its width.
$cornerFraction = 0.22

<#
    Append an SVG quadratic segment to a path as its cubic equivalent.
    GraphicsPath has no quadratic primitive; the control-point conversion is
    exact, not an approximation.
#>
function Add-Quad {
    param($path, $x0, $y0, $cx, $cy, $x1, $y1)
    $c1x = $x0 + 2.0 / 3.0 * ($cx - $x0)
    $c1y = $y0 + 2.0 / 3.0 * ($cy - $y0)
    $c2x = $x1 + 2.0 / 3.0 * ($cx - $x1)
    $c2y = $y1 + 2.0 / 3.0 * ($cy - $y1)
    $path.AddBezier($x0, $y0, $c1x, $c1y, $c2x, $c2y, $x1, $y1)
}

<# The shield outline: straight shoulders into one curve per side. #>
function New-ShieldPath {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $p.AddLine(64.0, 8.0, 104.0, 21.5)
    Add-Quad $p 104.0 21.5 108.0 22.8 108.0 27.0
    $p.AddLine(108.0, 27.0, 108.0, 60.0)
    Add-Quad $p 108.0 60.0 108.0 88.0 66.4 119.4
    Add-Quad $p 66.4 119.4 64.0 121.0 61.6 119.4
    Add-Quad $p 61.6 119.4 20.0 88.0 20.0 60.0
    $p.AddLine(20.0, 60.0, 20.0, 27.0)
    Add-Quad $p 20.0 27.0 20.0 22.8 24.0 21.5
    $p.CloseFigure()
    return $p
}

<# A rounded rectangle, for the tower and for the square icon's backdrop. #>
function New-RoundedRectPath {
    param($x, $y, $w, $h, $r)
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2.0
    $p.AddArc($x,          $y,          $d, $d, 180, 90)
    $p.AddArc($x + $w - $d, $y,          $d, $d, 270, 90)
    $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0,   90)
    $p.AddArc($x,          $y + $h - $d, $d, $d, 90,  90)
    $p.CloseFigure()
    return $p
}

<#
    One alert wave. The SVG writes these as elliptical-arc commands between
    two endpoints; GDI+ wants a centre, a radius and two angles, so derive
    them. Both arcs are circular (rx = ry) and short-way round, which makes
    the centre the apex of an isosceles triangle on the chord.
#>
function Add-Wave {
    param($graphics, $pen, $x0, $x1, $y, $r)
    $halfChord = ($x1 - $x0) / 2.0
    $cx = ($x0 + $x1) / 2.0
    # Centre sits *below* the chord so the arc bulges upward, away from the tower.
    $cy = $y + [Math]::Sqrt($r * $r - $halfChord * $halfChord)
    $start = [Math]::Atan2($y - $cy, $x0 - $cx) * 180.0 / [Math]::PI
    $end   = [Math]::Atan2($y - $cy, $x1 - $cx) * 180.0 / [Math]::PI
    $graphics.DrawArc($pen, $cx - $r, $cy - $r, $r * 2, $r * 2, $start, $end - $start)
}

<#
    Draw the white backdrop + mark at the given pixel size.

    `shape` picks the backdrop:
      rounded — ic_launcher.png
      circle  — ic_launcher_round.png
      square  — full-bleed, for the Play Store listing, which rejects any
                transparency and applies its own rounding
#>
function New-IconBitmap {
    param([int]$size, [ValidateSet('rounded', 'circle', 'square')][string]$shape)

    $render = $size * $supersample
    $bmp = New-Object System.Drawing.Bitmap($render, $render,
        [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    # ── White backdrop ──
    $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    switch ($shape) {
        'circle' { $g.FillEllipse($white, 0, 0, $render - 1, $render - 1) }
        'square' { $g.FillRectangle($white, 0, 0, $render, $render) }
        default  {
            $corner = $render * $cornerFraction
            $bg = New-RoundedRectPath 0 0 ($render - 1) ($render - 1) $corner
            $g.FillPath($white, $bg)
            $bg.Dispose()
        }
    }

    # ── Mark, scaled and centred on the canvas ──
    $k = ($render * $logoScale) / $markH
    $g.TranslateTransform($render / 2.0, $render / 2.0)
    $g.ScaleTransform($k, $k)
    $g.TranslateTransform(-$markCx, -$markCy)

    $brandBrush = New-Object System.Drawing.SolidBrush($brand)
    $shield = New-ShieldPath
    $g.FillPath($brandBrush, $shield)
    $shield.Dispose()

    $whiteBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $tower = New-RoundedRectPath 57.5 58.0 13.0 36.0 2.0
    $g.FillPath($whiteBrush, $tower)
    $tower.Dispose()
    $g.FillEllipse($whiteBrush, 60.0, 44.0, 8.0, 8.0)   # beacon lamp, r=4 at (64,48)

    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, 3.6)
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round
    Add-Wave $g $pen 53.6 74.4 42.0 12.0

    # The outer wave is held at 55% so the pair reads as one signal fading
    # outward rather than as two equal rings.
    $faint = New-Object System.Drawing.Pen(
        [System.Drawing.Color]::FromArgb(140, 255, 255, 255), 3.6)
    $faint.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $faint.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round
    Add-Wave $g $faint 46.7 81.3 36.0 22.0

    $pen.Dispose(); $faint.Dispose()
    $brandBrush.Dispose(); $whiteBrush.Dispose(); $white.Dispose()
    $g.Dispose()

    # ── Downsample ──
    $out = New-Object System.Drawing.Bitmap($size, $size,
        [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $og = [System.Drawing.Graphics]::FromImage($out)
    $og.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $og.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $og.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $og.Clear([System.Drawing.Color]::Transparent)
    $og.DrawImage($bmp, (New-Object System.Drawing.Rectangle(0, 0, $size, $size)))
    $og.Dispose()
    $bmp.Dispose()
    return $out
}

foreach ($entry in $densities.GetEnumerator()) {
    $dir = Join-Path $resDir $entry.Key
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }

    foreach ($variant in @(
        @{ name = 'ic_launcher.png';       shape = 'rounded' },
        @{ name = 'ic_launcher_round.png'; shape = 'circle'  }
    )) {
        $bmp = New-IconBitmap -size $entry.Value -shape $variant.shape
        $bmp.Save((Join-Path $dir $variant.name),
            [System.Drawing.Imaging.ImageFormat]::Png)
        $bmp.Dispose()
        Write-Host "wrote $($entry.Key)/$($variant.name) ($($entry.Value)px)"
    }
}

# Play Store listing icon: 512x512, uploaded by hand with the listing.
$store = New-IconBitmap -size 512 -shape 'square'
$store.Save((Join-Path $PSScriptRoot '..\assets\play-store-icon.png'),
    [System.Drawing.Imaging.ImageFormat]::Png)
$store.Dispose()
Write-Host 'wrote assets/play-store-icon.png (512px)'
