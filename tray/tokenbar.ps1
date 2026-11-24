#Requires -Version 5.1
<#
  TokenBar - indicador de cota das assinaturas Claude, Codex e Antigravity no Windows.
  Le o snapshot publicado por dist/daemon.js e desenha o painel; nao consulta os servicos.
#>
[CmdletBinding()]
param(
  [int] $IntervalSeconds = 60,
  [double] $Opacity = 0.92,
  [string] $PreviewPath,
  [string] $SnapshotFile,
  [string[]] $DisabledProviders = $null
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
$script:ConfigPath = Join-Path $script:StateDir 'tray-config.json'
$script:LogPath = Join-Path $script:StateDir 'tray.log'
$script:LastTickError = $null
# Atalho de versões anteriores, só para migração: ver Sync-StartupRegistration.
$startupDir = [Environment]::GetFolderPath('Startup')
$script:StartupLink = if ($startupDir) { Join-Path $startupDir 'TokenBar.lnk' } else { $null }
$script:StartupTaskName = 'TokenBar'
$script:TrayScript = $PSCommandPath
$script:Snapshot = $null
$script:SnapshotStamp = [datetime]::MinValue
$script:Daemon = $null
$script:CurrentIconHandle = [IntPtr]::Zero
$script:LastRender = [datetime]::MinValue

if ($PSBoundParameters.ContainsKey('DisabledProviders')) {
  Set-DisabledProviders $DisabledProviders
} else {
  Read-TrayConfig $script:ConfigPath
}

$script:Colors = @{
  Background  = [System.Drawing.Color]::FromArgb(26, 26, 26)
  Border      = [System.Drawing.Color]::FromArgb(52, 52, 52)
  Card        = [System.Drawing.Color]::FromArgb(38, 38, 38)
  CardBorder  = [System.Drawing.Color]::FromArgb(56, 56, 56)
  Track       = [System.Drawing.Color]::FromArgb(68, 68, 68)
  Text        = [System.Drawing.Color]::FromArgb(238, 238, 238)
  ValueText   = [System.Drawing.Color]::FromArgb(186, 186, 186)
  Muted       = [System.Drawing.Color]::FromArgb(150, 150, 150)
  SubtleMuted = [System.Drawing.Color]::FromArgb(112, 112, 112)
  Blue        = [System.Drawing.Color]::FromArgb(46, 134, 245)
  Red         = [System.Drawing.Color]::FromArgb(232, 75, 85)
  IconMuted   = [System.Drawing.Color]::FromArgb(90, 90, 90)
  IconInk     = [System.Drawing.Color]::FromArgb(255, 255, 255)
}

$script:Fonts = @{
  Title    = New-Object System.Drawing.Font('Segoe UI', 9.5, [System.Drawing.FontStyle]::Bold)
  Provider = New-Object System.Drawing.Font('Segoe UI', 9, [System.Drawing.FontStyle]::Bold)
  Label    = New-Object System.Drawing.Font('Segoe UI', 9, [System.Drawing.FontStyle]::Regular)
  Value    = New-Object System.Drawing.Font('Segoe UI', 9, [System.Drawing.FontStyle]::Regular)
  Meta     = New-Object System.Drawing.Font('Segoe UI', 8.5, [System.Drawing.FontStyle]::Regular)
  Small    = New-Object System.Drawing.Font('Segoe UI', 8, [System.Drawing.FontStyle]::Regular)
}

$script:Layout = @{
  Width       = 352
  Pad         = 10
  HeaderH     = 22
  CardPadX    = 12
  CardPadTop  = 10
  CardPadBot  = 12
  CardGap     = 8
  CardRadius  = 8
  ProviderH   = 24
  RowH        = 27
  RowGap      = 11
  EmptyRowH   = 18
  BarH        = 6
  BarOffsetY  = 21
  ValueW      = 32
}

function Get-Tone {
  param([double] $UsedPercent)
  if ($UsedPercent -ge 90) { return $script:Colors.Red }
  return $script:Colors.Blue
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


function Get-ProviderCardHeight {
  param($Provider)
  $windows = @(if ($Provider.windows) { $Provider.windows })
  if (-not $windows.Count) {
    return $script:Layout.CardPadTop + $script:Layout.ProviderH + $script:Layout.EmptyRowH + $script:Layout.CardPadBot
  }
  $rows = $windows.Count
  return $script:Layout.CardPadTop + $script:Layout.ProviderH + ($rows * $script:Layout.RowH) + (($rows - 1) * $script:Layout.RowGap) + $script:Layout.CardPadBot
}

function Get-PanelHeight {
  $providers = @(Get-VisibleProviders)
  $height = $script:Layout.Pad + $script:Layout.HeaderH + $script:Layout.Pad
  if (-not $providers.Count) { return $height + $script:Layout.EmptyRowH + 4 }
  for ($i = 0; $i -lt $providers.Count; $i++) {
    $height += Get-ProviderCardHeight $providers[$i]
    if ($i -lt ($providers.Count - 1)) { $height += $script:Layout.CardGap }
  }
  return $height
}


function Write-Panel {
  param([System.Drawing.Graphics] $Graphics, [int] $Width, [int] $Height)

  $Graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $Graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $Graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
  $Graphics.Clear($script:Colors.Background)

  $textBrush = New-Object System.Drawing.SolidBrush $script:Colors.Text
  $valueBrush = New-Object System.Drawing.SolidBrush $script:Colors.ValueText
  $mutedBrush = New-Object System.Drawing.SolidBrush $script:Colors.Muted
  $subtleBrush = New-Object System.Drawing.SolidBrush $script:Colors.SubtleMuted
  $cardBrush = New-Object System.Drawing.SolidBrush $script:Colors.Card
  $trackBrush = New-Object System.Drawing.SolidBrush $script:Colors.Track
  $borderPen = New-Object System.Drawing.Pen $script:Colors.Border
  $cardPen = New-Object System.Drawing.Pen $script:Colors.CardBorder

  $leftFmt = [System.Drawing.StringFormat]::GenericTypographic.Clone()
  $leftFmt.FormatFlags = [System.Drawing.StringFormatFlags]::NoWrap
  $leftFmt.Trimming = [System.Drawing.StringTrimming]::EllipsisCharacter

  $rightFmt = [System.Drawing.StringFormat]::GenericTypographic.Clone()
  $rightFmt.FormatFlags = [System.Drawing.StringFormatFlags]::NoWrap
  $rightFmt.Alignment = [System.Drawing.StringAlignment]::Far

  $Graphics.DrawRectangle($borderPen, 0, 0, $Width - 1, $Height - 1)

  $pad = $script:Layout.Pad
  $y = $pad
  $dot = ' ' + [char] 0x00B7 + ' '

  $Graphics.DrawString('Cotas', $script:Fonts.Title, $textBrush, [float] $pad, [float] $y, $leftFmt)
  $stampText = 'sem dados'
  if ($script:Snapshot) {
    $collected = Get-Date
    if ([datetime]::TryParse($script:Snapshot.collectedAt, [ref] $collected)) {
      $stampText = $collected.ToLocalTime().ToString('HH:mm')
    }
  }
  $stampRect = New-Object System.Drawing.RectangleF([float] $pad, [float] ($y + 2), [float] ($Width - 2 * $pad), 16)
  $Graphics.DrawString($stampText, $script:Fonts.Small, $mutedBrush, $stampRect, $rightFmt)
  $y += $script:Layout.HeaderH

  $providers = @(Get-VisibleProviders)
  if (-not $providers.Count) {
    $noDataMsg = if ($script:Snapshot -and $script:Snapshot.providers -and @($script:Snapshot.providers).Count -gt 0) {
      'Nenhum provedor selecionado.'
    } else {
      'Sem dados.'
    }
    $Graphics.DrawString($noDataMsg, $script:Fonts.Label, $mutedBrush, [float] $pad, [float] ($y + 2), $leftFmt)
  }

  $cardX = [float] $pad
  $cardW = [float] ($Width - 2 * $pad)
  $innerX = $cardX + $script:Layout.CardPadX
  $innerW = $cardW - (2 * $script:Layout.CardPadX)
  $innerRight = $innerX + $innerW
  $barH = [float] $script:Layout.BarH
  $barRadius = [float] ($barH / 2)

  for ($p = 0; $p -lt $providers.Count; $p++) {
    $provider = $providers[$p]
    $cardH = [float] (Get-ProviderCardHeight $provider)
    $cardRect = New-Object System.Drawing.RectangleF($cardX, [float] $y, $cardW, $cardH)
    $cardPath = Get-RoundedPath $cardRect ([float] $script:Layout.CardRadius)
    $Graphics.FillPath($cardBrush, $cardPath)
    $Graphics.DrawPath($cardPen, $cardPath)
    $cardPath.Dispose()

    $headerY = [float] ($y + $script:Layout.CardPadTop)
    $providerName = [string] $provider.label
    $Graphics.DrawString($providerName, $script:Fonts.Provider, $textBrush, $innerX, $headerY, $leftFmt)
    $nameW = $Graphics.MeasureString($providerName, $script:Fonts.Provider, [System.Drawing.PointF]::Empty, $leftFmt).Width

    $tagParts = @()
    if ($provider.plan) { $tagParts += [string] $provider.plan }
    if ($provider.stale -or (Test-ProviderOutdated $provider)) { $tagParts += 'cache' }
    $failure = Get-FailureLabel $provider
    if ($failure) { $tagParts += $failure }
    $tag = if ($tagParts.Count) { $dot + ($tagParts -join $dot) } else { '' }

    $tagW = if ($tag) { $Graphics.MeasureString($tag, $script:Fonts.Meta, [System.Drawing.PointF]::Empty, $leftFmt).Width } else { 0.0 }
    $costText = Get-CostText $provider
    $costW = 0.0
    if ($costText) {
      $fullLeftW = $nameW + $tagW + 8
      $minLeftW = $nameW + 10
      $measuredCost = $Graphics.MeasureString($costText, $script:Fonts.Small, [System.Drawing.PointF]::Empty, $leftFmt).Width
      if ($measuredCost -gt ($innerW - $fullLeftW)) {
        $costText = ($costText -split $dot)[0]
        $measuredCost = $Graphics.MeasureString($costText, $script:Fonts.Small, [System.Drawing.PointF]::Empty, $leftFmt).Width
      }
      if ($measuredCost -le ($innerW - $minLeftW)) {
        $costW = $measuredCost
        $costRect = New-Object System.Drawing.RectangleF($innerX, [float] ($headerY + 1.5), $innerW, 16)
        $Graphics.DrawString($costText, $script:Fonts.Small, $mutedBrush, $costRect, $rightFmt)
      }
    }

    if ($tag) {
      $tagX = $innerX + $nameW
      $tagMaxRight = if ($costW -gt 0) { $innerRight - $costW - 8 } else { $innerRight }
      $tagAvailW = $tagMaxRight - $tagX
      if ($tagAvailW -gt 16) {
        $tagRect = New-Object System.Drawing.RectangleF($tagX, [float] ($headerY + 1), $tagAvailW, 16)
        $Graphics.DrawString($tag, $script:Fonts.Meta, $mutedBrush, $tagRect, $leftFmt)
      }
    }

    $rowY = $headerY + $script:Layout.ProviderH
    $windows = @(if ($provider.windows) { $provider.windows })
    if (-not $windows.Count) {
      $Graphics.DrawString('Sem dados.', $script:Fonts.Meta, $mutedBrush, $innerX, [float] ($rowY + 1), $leftFmt)
      $y += $cardH + $script:Layout.CardGap
      continue
    }

    $providerOutdated = Test-ProviderOutdated $provider
    for ($w = 0; $w -lt $windows.Count; $w++) {
      $window = $windows[$w]
      $used = [double] $window.usedPercent
      $expired = Test-WindowExpired $window
      $old = $providerOutdated -or $expired
      $tone = if ($old) { $script:Colors.SubtleMuted } else { Get-Tone $used }
      $toneBrush = New-Object System.Drawing.SolidBrush $tone
      $rowLabelBrush = if ($old) { $mutedBrush } else { $textBrush }
      $rowValueBrush = if ($old) { $subtleBrush } else { $valueBrush }

      $valueW = [float] $script:Layout.ValueW
      $valueRect = New-Object System.Drawing.RectangleF(($innerRight - $valueW), $rowY, $valueW, 18)
      $valueText = '{0:0}%' -f $used
      $Graphics.DrawString($valueText, $script:Fonts.Value, $rowValueBrush, $valueRect, $rightFmt)

      $resetText = Format-ResetTime ([string] $window.resetsAt)
      $resetRight = $innerRight - $valueW - 6
      $resetW = 0.0
      if ($resetText) {
        $resetW = $Graphics.MeasureString($resetText, $script:Fonts.Meta, [System.Drawing.PointF]::Empty, $leftFmt).Width
        $resetRect = New-Object System.Drawing.RectangleF($innerX, [float] ($rowY + 1), ($resetRight - $innerX), 18)
        $Graphics.DrawString($resetText, $script:Fonts.Meta, $mutedBrush, $resetRect, $rightFmt)
      }

      $labelMaxRight = if ($resetW -gt 0) { $resetRight - $resetW - 10 } else { $resetRight - 6 }
      $labelAvailW = [math]::Max(40, $labelMaxRight - $innerX)
      $labelRect = New-Object System.Drawing.RectangleF($innerX, $rowY, [float] $labelAvailW, 18)
      $Graphics.DrawString((Get-WindowDisplayLabel $window), $script:Fonts.Label, $rowLabelBrush, $labelRect, $leftFmt)

      $barY = [float] ($rowY + $script:Layout.BarOffsetY)
      $trackRect = New-Object System.Drawing.RectangleF($innerX, $barY, $innerW, $barH)
      $trackPath = Get-RoundedPath $trackRect $barRadius
      $Graphics.FillPath($trackBrush, $trackPath)
      $trackPath.Dispose()

      if (-not $expired -and $used -gt 0) {
        $fillWidth = [math]::Max($barH, ($innerW * [math]::Min(100, [math]::Max(0, $used)) / 100))
        $fillRect = New-Object System.Drawing.RectangleF($innerX, $barY, [float] $fillWidth, $barH)
        $fillPath = Get-RoundedPath $fillRect $barRadius
        $Graphics.FillPath($toneBrush, $fillPath)
        $fillPath.Dispose()
      }

      $toneBrush.Dispose()
      $rowY += $script:Layout.RowH
      if ($w -lt ($windows.Count - 1)) { $rowY += $script:Layout.RowGap }
    }
    $y += $cardH + $script:Layout.CardGap
  }

  $leftFmt.Dispose()
  $rightFmt.Dispose()
  $textBrush.Dispose()
  $valueBrush.Dispose()
  $mutedBrush.Dispose()
  $subtleBrush.Dispose()
  $cardBrush.Dispose()
  $trackBrush.Dispose()
  $borderPen.Dispose()
  $cardPen.Dispose()
}

function New-TrayIcon {
  $worst = Get-WorstUsage
  $bitmap = New-Object System.Drawing.Bitmap 32, 32
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
  $graphics.Clear([System.Drawing.Color]::Transparent)

  if ($worst) {
    $tone = Get-Tone ([double] $worst.usedPercent)
    $text = '{0:0}' -f [double] $worst.usedPercent
  } else {
    $tone = $script:Colors.IconMuted
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
  if (-not (Test-DaemonStartAllowed)) { return }
  if ($script:Daemon) {
    Write-TrayLog $script:LogPath ('daemon encerrou (codigo {0}, apos {1:0}s)' -f $script:Daemon.ExitCode, ($script:Daemon.ExitTime - $script:Daemon.StartTime).TotalSeconds)
    Register-DaemonExit ($script:Daemon.ExitTime - $script:Daemon.StartTime)
    $script:Daemon = $null
    if (-not (Test-DaemonStartAllowed)) { return }
  }
  Register-DaemonAttempt
  $node = Get-Command node -ErrorAction SilentlyContinue
  $nodePath = if ($node) { $node.Source } elseif (Test-Path 'C:\Program Files\nodejs\node.exe') { 'C:\Program Files\nodejs\node.exe' } else { $null }
  if (-not $nodePath -or -not (Test-Path $script:DaemonScript)) {
    Write-TrayLog $script:LogPath 'daemon nao lancado: node ou dist\daemon.js ausente'
    Register-DaemonLaunchFailure
    return
  }
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = $nodePath
  $info.Arguments = ('"{0}" {1}' -f $script:DaemonScript, $IntervalSeconds)
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  try {
    $script:Daemon = [System.Diagnostics.Process]::Start($info)
    Write-TrayLog $script:LogPath ('daemon iniciado (pid {0})' -f $script:Daemon.Id)
  } catch {
    Write-TrayLog $script:LogPath ('falha ao lancar o daemon: {0}' -f $_.Exception.Message)
    Register-DaemonLaunchFailure
  }
}

Write-TrayLog $script:LogPath 'bandeja iniciada'
# Antes de criar qualquer janela: exceções da interface caem no log em vez de derrubar o processo.
[System.Windows.Forms.Application]::SetUnhandledExceptionMode([System.Windows.Forms.UnhandledExceptionMode]::CatchException)
[System.Windows.Forms.Application]::add_ThreadException({ param($sender, $e) Write-TrayLog $script:LogPath ('excecao na interface: ' + $e.Exception) })
[System.AppDomain]::CurrentDomain.add_UnhandledException({ param($sender, $e) Write-TrayLog $script:LogPath ('excecao nao tratada: ' + $e.ExceptionObject) })

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

# O conteúdo é pintado com GDI+, sem controles que um leitor de tela enxergue. O UI Automation
# anuncia como nome da janela o texto dela (invisível: o painel não tem barra de título),
# então o mesmo conteúdo, em texto, vai para Text e AccessibleName a cada atualização.
function Update-PanelAccessibility {
  $text = 'TokenBar, cotas das assinaturas. ' + (Get-PanelAccessibleText)
  $script:Form.Text = $text
  $script:Form.AccessibleName = $text
}

function Show-Panel {
  $script:Form.Height = Get-PanelHeight
  $screen = [System.Windows.Forms.Screen]::FromPoint([System.Windows.Forms.Cursor]::Position)
  $area = $screen.WorkingArea
  $script:Form.Location = New-Object System.Drawing.Point (($area.Right - $script:Form.Width - 12), ($area.Bottom - $script:Form.Height - 12))
  Update-PanelAccessibility
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
  Update-PanelAccessibility
  $script:LastRender = [datetime]::UtcNow
  if ($script:Form.Visible) {
    $script:Form.Height = Get-PanelHeight
    $script:Form.Invalidate()
  }
}

# "Iniciar com o Windows" é uma tarefa agendada do usuário, disparada no logon dele, sem
# privilégio elevado. Antes era um .lnk na pasta de Inicialização, e um atalho que abre o
# PowerShell oculto ali é tratado por antivírus como LNK malicioso (HEUR:Trojan.WinLNK.Agent.gen).
function Get-StartupTask {
  try {
    return (Get-ScheduledTask -TaskPath '\' -TaskName $script:StartupTaskName -ErrorAction Stop)
  } catch {
    return $null
  }
}

# Devolve $true só se a tarefa foi registrada apontando para executáveis que existem; sem um
# host PowerShell válido não registra nada, e a opção do menu não é marcada.
function Save-StartupTask {
  param([string] $SystemRoot = $env:SystemRoot, [string] $HostHome = $PSHOME)
  $conhost = Join-Path $SystemRoot 'System32\conhost.exe'
  $hostExe = Resolve-StartupHost $SystemRoot $HostHome
  if (-not $hostExe -or -not (Test-Path -LiteralPath $conhost -PathType Leaf)) {
    Write-TrayLog $script:LogPath 'inicializacao com o Windows nao configurada: conhost ou host PowerShell ausente'
    return $false
  }
  try {
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $action = New-ScheduledTaskAction -Execute $conhost -Argument (Get-StartupArguments $hostExe $script:TrayScript) -WorkingDirectory $script:Root
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    # Sem limite de execução: o padrão de 72 h encerraria a bandeja depois de três dias ligada.
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([timespan]::Zero) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskPath '\' -TaskName $script:StartupTaskName -Description 'TokenBar' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force -ErrorAction Stop | Out-Null
  } catch {
    Write-TrayLog $script:LogPath ('inicializacao com o Windows nao configurada: ' + $_.Exception.Message)
    return $false
  }
  return [bool] (Get-StartupTask)
}

function Remove-StartupTask {
  try {
    Unregister-ScheduledTask -TaskPath '\' -TaskName $script:StartupTaskName -Confirm:$false -ErrorAction Stop
  } catch {
    Write-TrayLog $script:LogPath ('falha ao remover a inicializacao com o Windows: ' + $_.Exception.Message)
  }
}

# Na abertura: quem tinha o atalho antigo passa para a tarefa, e uma tarefa que aponta para um
# host inexistente ou para outro tokenbar.ps1 é refeita. Devolve se a opção está ativa.
function Sync-StartupRegistration {
  $hadLink = [bool] $script:StartupLink -and (Test-Path -LiteralPath $script:StartupLink -PathType Leaf)
  if ($hadLink) {
    try {
      Remove-Item -LiteralPath $script:StartupLink -Force -ErrorAction Stop
    } catch {
      Write-TrayLog $script:LogPath ('falha ao remover o atalho antigo de inicializacao: ' + $_.Exception.Message)
    }
  }
  $task = Get-StartupTask
  if (-not $task) {
    if ($hadLink) { return [bool] (Save-StartupTask) }
    return $false
  }
  $action = @($task.Actions)[0]
  if (-not (Test-StartupCommandCurrent $action.Execute $action.Arguments $script:TrayScript)) { return [bool] (Save-StartupTask) }
  return $true
}

$script:Menu = New-Object System.Windows.Forms.ContextMenuStrip
$refreshItem = $script:Menu.Items.Add('Atualizar agora')
$refreshItem.Add_Click({
  Reset-DaemonBackoff
  Start-Daemon
  New-Item -ItemType File -Path $script:RefreshFlagPath -Force | Out-Null
})

$script:ProvidersMenu = New-Object System.Windows.Forms.ToolStripMenuItem('Provedores')
$knownProviders = @(
  @{ Id = 'claude'; Label = 'Claude' },
  @{ Id = 'codex'; Label = 'Codex' },
  @{ Id = 'antigravity'; Label = 'Antigravity' }
)

foreach ($p in $knownProviders) {
  $item = New-Object System.Windows.Forms.ToolStripMenuItem($p.Label)
  $item.CheckOnClick = $true
  $item.Tag = [string] $p.Id
  $item.Checked = -not ($script:DisabledProviders -contains $p.Id)
  $item.Add_Click({
    param($sender, $e)
    $id = [string] $sender.Tag
    if ($sender.Checked) {
      Set-DisabledProviders @($script:DisabledProviders | Where-Object { $_ -ne $id })
    } else {
      if (-not ($script:DisabledProviders -contains $id)) {
        Set-DisabledProviders (@($script:DisabledProviders) + $id)
      }
    }
    Save-TrayConfig $script:ConfigPath
    Update-Tray
  })
  [void] $script:ProvidersMenu.DropDownItems.Add($item)
}
$script:ProvidersMenu.Add_DropDownOpening({
  foreach ($item in $script:ProvidersMenu.DropDownItems) {
    if ($item.Tag) {
      $item.Checked = -not ($script:DisabledProviders -contains [string] $item.Tag)
    }
  }
})
[void] $script:Menu.Items.Add($script:ProvidersMenu)

$script:StartupItem = $script:Menu.Items.Add('Iniciar com o Windows')
$script:StartupItem.Checked = [bool] (Sync-StartupRegistration)
$script:StartupItem.Add_Click({
  if (Get-StartupTask) { Remove-StartupTask } else { [void] (Save-StartupTask) }
  $script:StartupItem.Checked = [bool] (Get-StartupTask)
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
  try {
    Start-Daemon
    if ((Read-Snapshot) -or $script:Form.Visible -or ([datetime]::UtcNow - $script:LastRender).TotalSeconds -ge 30) { Update-Tray }
  } catch {
    # Um erro que se repete a cada 3 s é registrado uma vez só.
    $text = $_.Exception.Message + ' @ ' + $_.ScriptStackTrace
    if ($text -ne $script:LastTickError) {
      $script:LastTickError = $text
      Write-TrayLog $script:LogPath ('erro no ciclo de atualizacao: ' + $text)
    }
  }
})

Start-Daemon
[void] (Read-Snapshot)
Update-Tray
$script:Timer.Start()

$script:Context = New-Object System.Windows.Forms.ApplicationContext
[System.Windows.Forms.Application]::Run($script:Context)
Write-TrayLog $script:LogPath 'bandeja encerrada normalmente'

$script:Timer.Stop()
$script:Notify.Visible = $false
$script:Notify.Dispose()
if ($script:CurrentIconHandle -ne [IntPtr]::Zero) { [void] [TokenBar.Native]::DestroyIcon($script:CurrentIconHandle) }
if ($script:Daemon -and -not $script:Daemon.HasExited) { $script:Daemon.Kill() }
