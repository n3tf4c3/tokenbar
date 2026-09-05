#Requires -Version 5.1
<#
  TokenBar - indicador de cota das assinaturas Claude e Codex na bandeja do Windows.
  Le o snapshot publicado por dist/daemon.js e desenha o painel; nao consulta os servicos.
#>
[CmdletBinding()]
param(
  [int] $IntervalSeconds = 60,
  [double] $Opacity = 0.92,
  [string] $PreviewPath,
  [string] $SnapshotFile
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace TokenBar -Name Native -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true)]
public static extern bool DestroyIcon(IntPtr handle);
'@

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'state.ps1')
$script:Root = Split-Path -Parent $PSScriptRoot
$script:DaemonScript = Join-Path $script:Root 'dist\daemon.js'
$script:StateDir = Join-Path $env:LOCALAPPDATA 'tokenbar'
$script:SnapshotPath = Join-Path $script:StateDir 'snapshot.json'
if ($PreviewPath -and $SnapshotFile) { $script:SnapshotPath = $SnapshotFile }
$script:RefreshFlagPath = Join-Path $script:StateDir 'refresh.flag'
$script:StartupLink = Join-Path ([Environment]::GetFolderPath('Startup')) 'TokenBar.lnk'
$script:Snapshot = $null
$script:SnapshotStamp = [datetime]::MinValue
$script:Daemon = $null
$script:CurrentIconHandle = [IntPtr]::Zero
$script:LastRender = [datetime]::MinValue

$script:Colors = @{
  Background = [System.Drawing.Color]::FromArgb(17, 21, 29)
  Border     = [System.Drawing.Color]::FromArgb(35, 42, 54)
  Track      = [System.Drawing.Color]::FromArgb(36, 42, 53)
  Text       = [System.Drawing.Color]::FromArgb(238, 242, 247)
  Muted      = [System.Drawing.Color]::FromArgb(140, 151, 168)
  Green      = [System.Drawing.Color]::FromArgb(93, 225, 162)
  Amber      = [System.Drawing.Color]::FromArgb(255, 189, 102)
  Red        = [System.Drawing.Color]::FromArgb(255, 107, 120)
  IconInk    = [System.Drawing.Color]::FromArgb(11, 14, 19)
}

$script:Fonts = @{
  Title    = New-Object System.Drawing.Font('Segoe UI', 10.5, [System.Drawing.FontStyle]::Bold)
  Provider = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)
  Value    = New-Object System.Drawing.Font('Segoe UI', 9, [System.Drawing.FontStyle]::Bold)
  Body     = New-Object System.Drawing.Font('Segoe UI', 8.5, [System.Drawing.FontStyle]::Regular)
  Small    = New-Object System.Drawing.Font('Segoe UI', 8, [System.Drawing.FontStyle]::Regular)
}

$script:Layout = @{
  Width       = 430
  Pad         = 14
  HeaderH     = 30
  ProviderH   = 24
  RowH        = 26
  InfoH       = 18
  NoticeH     = 40
  ProviderGap = 10
  LabelW      = 64
  BarW        = 110
  ValueW      = 58
}

function Get-Tone {
  param([double] $UsedPercent)
  if ($UsedPercent -ge 90) { return $script:Colors.Red }
  if ($UsedPercent -ge 70) { return $script:Colors.Amber }
  return $script:Colors.Green
}



function Get-RoundedPath {
  param([System.Drawing.RectangleF] $Rect, [float] $Radius)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $diameter = $Radius * 2
  if ($diameter -le 0 -or $diameter -gt [math]::Min($Rect.Width, $Rect.Height)) {
    $path.AddRectangle($Rect)
    return $path
  }
  $path.AddArc($Rect.X, $Rect.Y, $diameter, $diameter, 180, 90)
  $path.AddArc($Rect.Right - $diameter, $Rect.Y, $diameter, $diameter, 270, 90)
  $path.AddArc($Rect.Right - $diameter, $Rect.Bottom - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($Rect.X, $Rect.Bottom - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}


function Get-PanelHeight {
  $providers = @(Get-VisibleProviders)
  $height = $script:Layout.Pad + $script:Layout.HeaderH + $script:Layout.Pad
  if (-not $providers.Count) { return $height + $script:Layout.RowH }
  foreach ($provider in $providers) {
    $rows = @($provider.windows).Count
    $height += $script:Layout.ProviderH + ($rows * $script:Layout.RowH) + $script:Layout.ProviderGap
    $height += @(Get-ProviderInfo $provider).Count * $script:Layout.InfoH
    if (Get-ProviderNotice $provider) { $height += $script:Layout.NoticeH }
  }
  return $height
}


function Write-Panel {
  param([System.Drawing.Graphics] $Graphics, [int] $Width, [int] $Height)

  $Graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $Graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
  $Graphics.Clear($script:Colors.Background)

  $textBrush = New-Object System.Drawing.SolidBrush $script:Colors.Text
  $mutedBrush = New-Object System.Drawing.SolidBrush $script:Colors.Muted
  $noticeBrush = New-Object System.Drawing.SolidBrush $script:Colors.Amber
  $trackBrush = New-Object System.Drawing.SolidBrush $script:Colors.Track
  $borderPen = New-Object System.Drawing.Pen $script:Colors.Border

  $Graphics.DrawRectangle($borderPen, 0, 0, $Width - 1, $Height - 1)

  $pad = $script:Layout.Pad
  $y = $pad

  $Graphics.DrawString('Cotas das assinaturas', $script:Fonts.Title, $textBrush, [float] $pad, [float] $y)
  $stampText = 'sem dados'
  if ($script:Snapshot) {
    $collected = Get-Date
    if ([datetime]::TryParse($script:Snapshot.collectedAt, [ref] $collected)) {
      $stampText = 'painel ' + $collected.ToLocalTime().ToString('HH:mm')
    }
  }
  $stampSize = $Graphics.MeasureString($stampText, $script:Fonts.Small)
  $Graphics.DrawString($stampText, $script:Fonts.Small, $mutedBrush, [float] ($Width - $pad - $stampSize.Width), [float] ($y + 4))
  $y += $script:Layout.HeaderH

  $providers = @(Get-VisibleProviders)
  if (-not $providers.Count) {
    $Graphics.DrawString('Aguardando o primeiro snapshot do daemon...', $script:Fonts.Body, $mutedBrush, [float] $pad, [float] $y)
  }

  foreach ($provider in $providers) {
    $Graphics.DrawString([string] $provider.label, $script:Fonts.Provider, $textBrush, [float] $pad, [float] $y)
    $tag = Get-ProviderState $provider
    if ($provider.plan) { $tag = [string] $provider.plan + ' ' + [char] 0x00B7 + ' ' + $tag }
    if ($tag) {
      $tagSize = $Graphics.MeasureString($tag, $script:Fonts.Small)
      $tagBrush = if (Test-ProviderAttention $provider) { $noticeBrush } else { $mutedBrush }
      $Graphics.DrawString($tag, $script:Fonts.Small, $tagBrush, [float] ($Width - $pad - $tagSize.Width), [float] ($y + 3))
    }
    $y += $script:Layout.ProviderH

    foreach ($info in @(Get-ProviderInfo $provider)) {
      $Graphics.DrawString([string] $info, $script:Fonts.Small, $mutedBrush, [float] $pad, [float] $y)
      $y += $script:Layout.InfoH
    }
    $notice = Get-ProviderNotice $provider
    if ($notice) {
      $rect = New-Object System.Drawing.RectangleF([float] $pad, [float] $y, [float] ($Width - (2 * $pad)), [float] $script:Layout.NoticeH)
      $Graphics.DrawString($notice, $script:Fonts.Small, $noticeBrush, $rect)
      $y += $script:Layout.NoticeH
    }

    foreach ($window in @($provider.windows)) {
      $used = [double] $window.usedPercent
      $expired = Test-WindowExpired $window
      $old = (Test-ProviderOutdated $provider) -or $expired
      $tone = if ($old) { $script:Colors.Muted } else { Get-Tone $used }
      $toneBrush = New-Object System.Drawing.SolidBrush $tone

      $Graphics.DrawString((Get-WindowShortLabel $window), $script:Fonts.Body, $mutedBrush, [float] $pad, [float] ($y + 4))

      $barX = $pad + $script:Layout.LabelW
      $barY = $y + 10
      $trackRect = New-Object System.Drawing.RectangleF([float] $barX, [float] $barY, [float] $script:Layout.BarW, 6)
      $trackPath = Get-RoundedPath $trackRect 3
      $Graphics.FillPath($trackBrush, $trackPath)
      $trackPath.Dispose()

      if (-not $expired -and $used -gt 0) {
        $fillWidth = [math]::Max(3, ($script:Layout.BarW * [math]::Min(100, [math]::Max(0, $used)) / 100))
        $fillRect = New-Object System.Drawing.RectangleF([float] $barX, [float] $barY, [float] $fillWidth, 6)
        $fillPath = Get-RoundedPath $fillRect 3
        $Graphics.FillPath($toneBrush, $fillPath)
        $fillPath.Dispose()
      }

      $valueX = $barX + $script:Layout.BarW + 10
      $valueText = '{0:0}%' -f $used
      if ($old) { $valueText += '*' }
      $Graphics.DrawString($valueText, $script:Fonts.Value, $toneBrush, [float] $valueX, [float] ($y + 3))

      $resetText = Get-Countdown ([string] $window.resetsAt)
      if ($resetText) {
        $Graphics.DrawString($resetText, $script:Fonts.Small, $mutedBrush, [float] ($valueX + $script:Layout.ValueW), [float] ($y + 4))
      }
      $toneBrush.Dispose()
      $y += $script:Layout.RowH
    }
    $y += $script:Layout.ProviderGap
  }

  $textBrush.Dispose()
  $mutedBrush.Dispose()
  $noticeBrush.Dispose()
  $trackBrush.Dispose()
  $borderPen.Dispose()
}

function New-TrayIcon {
  $worst = Get-WorstUsage
  $bitmap = New-Object System.Drawing.Bitmap 32, 32
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
  $graphics.Clear([System.Drawing.Color]::Transparent)

  $attention = @((Get-VisibleProviders) | Where-Object { Test-ProviderAttention $_ }).Count -gt 0
  if ($attention) {
    $tone = $script:Colors.Amber
    $text = '!'
  } elseif ($worst) {
    $tone = Get-Tone ([double] $worst.usedPercent)
    $text = '{0:0}' -f [double] $worst.usedPercent
  } else {
    $tone = $script:Colors.Muted
    $text = '?'
  }

  $rect = New-Object System.Drawing.RectangleF 1, 1, 30, 30
  $path = Get-RoundedPath $rect 8
  $backBrush = New-Object System.Drawing.SolidBrush $tone
  $graphics.FillPath($backBrush, $path)
  $path.Dispose()
  $backBrush.Dispose()

  $size = 17
  if ($text.Length -ge 3) { $size = 12 }
  $font = New-Object System.Drawing.Font('Segoe UI', $size, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $format = New-Object System.Drawing.StringFormat
  $format.Alignment = [System.Drawing.StringAlignment]::Center
  $format.LineAlignment = [System.Drawing.StringAlignment]::Center
  $inkBrush = New-Object System.Drawing.SolidBrush $script:Colors.IconInk
  $graphics.DrawString($text, $font, $inkBrush, (New-Object System.Drawing.RectangleF 1, 1, 30, 31), $format)
  $inkBrush.Dispose()
  $font.Dispose()
  $format.Dispose()
  $graphics.Dispose()

  $handle = $bitmap.GetHicon()
  $bitmap.Dispose()
  return $handle
}


function Read-Snapshot {
  if (-not (Test-Path $script:SnapshotPath)) { return $false }
  $stamp = (Get-Item $script:SnapshotPath).LastWriteTimeUtc
  if ($stamp -eq $script:SnapshotStamp) { return $false }
  try {
    $script:Snapshot = Get-Content -Raw -Path $script:SnapshotPath -Encoding UTF8 | ConvertFrom-Json
    $script:SnapshotStamp = $stamp
    return $true
  } catch {
    return $false
  }
}

if ($PreviewPath) {
  [void] (Read-Snapshot)
  $height = Get-PanelHeight
  $bitmap = New-Object System.Drawing.Bitmap $script:Layout.Width, $height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  Write-Panel $graphics $script:Layout.Width $height
  $graphics.Dispose()
  $iconHandle = New-TrayIcon
  $icon = [System.Drawing.Icon]::FromHandle($iconHandle)
  $composite = New-Object System.Drawing.Bitmap $script:Layout.Width, ($height + 52)
  $canvas = [System.Drawing.Graphics]::FromImage($composite)
  $canvas.Clear([System.Drawing.Color]::FromArgb(9, 11, 16))
  $canvas.DrawImage($bitmap, 0, 0)
  $canvas.DrawIcon($icon, (New-Object System.Drawing.Rectangle 14, ($height + 10), 32, 32))
  $canvas.DrawImage($icon.ToBitmap(), (New-Object System.Drawing.Rectangle 60, ($height + 18), 16, 16))
  $canvas.Dispose()
  $composite.Save($PreviewPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $composite.Dispose()
  $icon.Dispose()
  [void] [TokenBar.Native]::DestroyIcon($iconHandle)
  $bitmap.Dispose()
  Write-Output ('Preview salvo em {0} ({1}x{2})' -f $PreviewPath, $script:Layout.Width, $height)
  return
}

function Start-Daemon {
  if ($script:Daemon -and -not $script:Daemon.HasExited) { return }
  $node = Get-Command node -ErrorAction SilentlyContinue
  $nodePath = if ($node) { $node.Source } elseif (Test-Path 'C:\Program Files\nodejs\node.exe') { 'C:\Program Files\nodejs\node.exe' } else { $null }
  if (-not $nodePath) { return }
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = $nodePath
  $info.Arguments = ('"{0}" {1}' -f $script:DaemonScript, $IntervalSeconds)
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $script:Daemon = [System.Diagnostics.Process]::Start($info)
}

$script:Form = New-Object System.Windows.Forms.Form
$script:Form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$script:Form.ShowInTaskbar = $false
$script:Form.TopMost = $true
$script:Form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$script:Form.BackColor = $script:Colors.Background
$script:Form.Opacity = [math]::Max(0.2, [math]::Min(1.0, $Opacity))
$script:Form.Width = $script:Layout.Width
$script:Form.Height = Get-PanelHeight
$script:Form.GetType().GetProperty('DoubleBuffered', [System.Reflection.BindingFlags]'Instance, NonPublic').SetValue($script:Form, $true, $null)
$script:Form.Add_Paint({ Write-Panel $_.Graphics $script:Form.ClientSize.Width $script:Form.ClientSize.Height })
$script:Form.Add_Deactivate({ $script:Form.Hide() })

function Show-Panel {
  $script:Form.Height = Get-PanelHeight
  $screen = [System.Windows.Forms.Screen]::FromPoint([System.Windows.Forms.Cursor]::Position)
  $area = $screen.WorkingArea
  $script:Form.Location = New-Object System.Drawing.Point (($area.Right - $script:Form.Width - 12), ($area.Bottom - $script:Form.Height - 12))
  $script:Form.Invalidate()
  $script:Form.Show()
  $script:Form.Activate()
}

function Update-Tray {
  $handle = New-TrayIcon
  $previous = $script:CurrentIconHandle
  $script:Notify.Icon = [System.Drawing.Icon]::FromHandle($handle)
  $script:CurrentIconHandle = $handle
  if ($previous -ne [IntPtr]::Zero) { [void] [TokenBar.Native]::DestroyIcon($previous) }
  $script:Notify.Text = Get-TooltipText
  $script:LastRender = [datetime]::UtcNow
  if ($script:Form.Visible) {
    $script:Form.Height = Get-PanelHeight
    $script:Form.Invalidate()
  }
}

$script:Menu = New-Object System.Windows.Forms.ContextMenuStrip
$refreshItem = $script:Menu.Items.Add('Atualizar agora')
$refreshItem.Add_Click({
  Start-Daemon
  New-Item -ItemType File -Path $script:RefreshFlagPath -Force | Out-Null
})
$script:StartupItem = $script:Menu.Items.Add('Iniciar com o Windows')
$script:StartupItem.Checked = (Test-Path $script:StartupLink)
$script:StartupItem.Add_Click({
  if (Test-Path $script:StartupLink) {
    Remove-Item $script:StartupLink -Force
    $script:StartupItem.Checked = $false
  } else {
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut($script:StartupLink)
    $link.TargetPath = 'wscript.exe'
    $link.Arguments = ('\"{0}\"' -f (Join-Path $PSScriptRoot 'tokenbar.vbs'))
    $link.WorkingDirectory = $script:Root
    $link.Description = 'TokenBar'
    $link.Save()
    $script:StartupItem.Checked = $true
  }
})
[void] $script:Menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$exitItem = $script:Menu.Items.Add('Sair')
$exitItem.Add_Click({ $script:Context.ExitThread() })

$script:Notify = New-Object System.Windows.Forms.NotifyIcon
$script:Notify.Visible = $true
$script:Notify.ContextMenuStrip = $script:Menu
$script:Notify.Add_MouseClick({
  if ($_.Button -ne [System.Windows.Forms.MouseButtons]::Left) { return }
  if ($script:Form.Visible) { $script:Form.Hide() } else { Show-Panel }
})

$script:Timer = New-Object System.Windows.Forms.Timer
$script:Timer.Interval = 3000
$script:Timer.Add_Tick({
  Start-Daemon
  if ((Read-Snapshot) -or $script:Form.Visible -or ([datetime]::UtcNow - $script:LastRender).TotalSeconds -ge 30) { Update-Tray }
})

Start-Daemon
[void] (Read-Snapshot)
Update-Tray
$script:Timer.Start()

$script:Context = New-Object System.Windows.Forms.ApplicationContext
[System.Windows.Forms.Application]::Run($script:Context)

$script:Timer.Stop()
$script:Notify.Visible = $false
$script:Notify.Dispose()
if ($script:CurrentIconHandle -ne [IntPtr]::Zero) { [void] [TokenBar.Native]::DestroyIcon($script:CurrentIconHandle) }
if ($script:Daemon -and -not $script:Daemon.HasExited) { $script:Daemon.Kill() }
