# Funcoes de estado sem GUI, compartilhadas pela bandeja e pelos testes Windows.

function ConvertTo-UsageTimestamp {
  param([string] $Value)
  $parsed = [DateTimeOffset]::MinValue
  if ($Value -and [DateTimeOffset]::TryParse($Value, [ref] $parsed)) { return $parsed }
  return $null
}

function Get-WindowShortLabel {
  param($Window)
  if ($Window.durationMinutes) {
    $minutes = [int] $Window.durationMinutes
    if ($minutes -eq 300) { return '5h' }
    if ($minutes -eq 10080) { return 'sem' }
    if ($minutes % 1440 -eq 0) { return "$($minutes / 1440)d" }
    if ($minutes % 60 -eq 0) { return "$($minutes / 60)h" }
    return "${minutes}m"
  }
  if ($Window.id -eq 'five_hour') { return '5h' }
  if ($Window.id -eq 'seven_day') { return 'sem' }
  if ($Window.id -like 'weekly_*') {
    $model = $Window.label -replace ('^.*' + [char] 0x00B7 + '\s*'), ''
    if ($model -and $model -ne $Window.label) { return "sem $model" }
    return 'sem'
  }
  return '-'
}

function Get-Countdown {
  param([string] $ResetsAt, [DateTimeOffset] $Now = [DateTimeOffset]::UtcNow)
  $target = ConvertTo-UsageTimestamp $ResetsAt
  if (-not $target) { return '' }
  $span = $target - $Now
  if ($span.TotalSeconds -le 0) { return 'aguardando coleta' }
  if ($span.TotalDays -ge 1) { return ('renova em {0}d {1}h' -f $span.Days, $span.Hours) }
  if ($span.TotalHours -ge 1) { return ('renova em {0}h {1}m' -f $span.Hours, $span.Minutes) }
  return ('renova em {0}m' -f [math]::Max(1, [math]::Floor($span.TotalMinutes)))
}

function Get-VisibleProviders {
  if ($script:Snapshot) { return @($script:Snapshot.providers) }
}

function Test-WindowExpired {
  param($Window, [DateTimeOffset] $Now = [DateTimeOffset]::UtcNow)
  if (-not $Window.resetsAt) { return $false }
  $reset = ConvertTo-UsageTimestamp $Window.resetsAt
  return (-not $reset -or $reset -le $Now)
}

function Test-ProviderOutdated {
  param($Provider, [DateTimeOffset] $Now = [DateTimeOffset]::UtcNow)
  $collected = ConvertTo-UsageTimestamp $Provider.collectedAt
  return ($Provider.status -ne 'ok' -or -not $collected -or ($Now - $collected).TotalMinutes -ge 10)
}

function Test-ProviderAttention {
  param($Provider, [DateTimeOffset] $Now = [DateTimeOffset]::UtcNow)
  if ((Test-ProviderOutdated $Provider $Now) -or -not $Provider.windows) { return $true }
  foreach ($window in @($Provider.windows)) { if (Test-WindowExpired $window $Now) { return $true } }
  return $false
}

function Get-ProviderState {
  param($Provider, [DateTimeOffset] $Now = [DateTimeOffset]::UtcNow)
  if ($Provider.failureKind -eq 'auth') { return 'renovar sessao' }
  if ($Provider.failureKind -eq 'rate-limit') { return 'aguardando consulta' }
  if ($Provider.status -eq 'error') { return 'erro na consulta' }
  if (Test-ProviderAttention $Provider $Now) { return 'sem atualizacao' }
  if ($Provider.stale) { return 'cache recente' }
  return 'em dia'
}

function Get-ProviderInfo {
  param($Provider, [DateTimeOffset] $Now = [DateTimeOffset]::UtcNow)
  $collected = ConvertTo-UsageTimestamp $Provider.collectedAt
  if ($collected -and $Provider.windows) {
    $minutes = [math]::Max(0, [math]::Floor(($Now - $collected).TotalMinutes))
    $age = 'ha menos de 1 min'
    if ($minutes -ge 1440) { $age = 'ha {0}d {1}h' -f [math]::Floor($minutes / 1440), [math]::Floor(($minutes % 1440) / 60) }
    elseif ($minutes -ge 60) { $age = 'ha {0}h {1}min' -f [math]::Floor($minutes / 60), ($minutes % 60) }
    elseif ($minutes -ge 1) { $age = "ha $minutes min" }
    'Ultima coleta: {0} - {1}' -f $collected.ToLocalTime().ToString('dd/MM HH:mm:ss'), $age
  } else { 'Sem coleta valida' }
  $retry = ConvertTo-UsageTimestamp $Provider.nextRetryAt
  if ($retry -and $retry -gt $Now) { 'Proxima tentativa: {0}' -f $retry.ToLocalTime().ToString('dd/MM HH:mm:ss') }
}

function Get-ProviderNotice {
  param($Provider, [DateTimeOffset] $Now = [DateTimeOffset]::UtcNow)
  if ($Provider.message -and $Provider.status -ne 'ok') {
    $message = [string] $Provider.message
    if ($Provider.windows) { $message += ' (* valores anteriores)' }
    return $message
  }
  if (Test-ProviderAttention $Provider $Now) { return '* Ultimo dado conhecido. Aguardando uma nova coleta valida.' }
  return ''
}

function Get-WorstUsage {
  param([DateTimeOffset] $Now = [DateTimeOffset]::UtcNow)
  $worst = $null
  foreach ($provider in @(Get-VisibleProviders)) {
    if (Test-ProviderOutdated $provider $Now) { continue }
    foreach ($window in @($provider.windows)) {
      if (Test-WindowExpired $window $Now) { continue }
      if (-not $worst -or $window.usedPercent -gt $worst.usedPercent) { $worst = $window }
    }
  }
  return $worst
}

function Get-TooltipText {
  param([DateTimeOffset] $Now = [DateTimeOffset]::UtcNow)
  $providers = @(Get-VisibleProviders)
  if (-not $providers.Count) { return 'TokenBar - sem dados' }
  $parts = foreach ($provider in $providers) {
    if (Test-ProviderAttention $provider $Now) {
      '{0}: {1}' -f $provider.label, (Get-ProviderState $provider $Now)
    } else {
      $values = foreach ($window in @($provider.windows)) {
        '{0} {1:0}%' -f (Get-WindowShortLabel $window), [double] $window.usedPercent
      }
      '{0}: {1}' -f $provider.label, ($values -join ' ')
    }
  }
  $text = $parts -join ' | '
  if ($text.Length -gt 63) { return $text.Substring(0, 60) + '...' }
  return $text
}
