$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\..\tray\state.ps1')
$now = [DateTimeOffset]'2026-09-05T13:00:00Z'
$passed = 0
function Assert-Equal {
  param($Actual, $Expected, [string] $Message)
  if ($Actual -ne $Expected) { throw "$Message - expected: $Expected; actual: $Actual" }
  $script:passed++
  Write-Output "PASS: $Message"
}
Assert-Equal (Get-Countdown '2026-09-05T14:45:00Z' $now) 'renova em 1h 45m' 'Hours are truncated, not rounded'
Assert-Equal (Get-Countdown '2026-09-07T07:00:00Z' $now) 'renova em 1d 18h' 'Days are truncated, not rounded'
Assert-Equal (Get-Countdown '2026-09-05T13:00:20Z' $now) 'renova em 1m' 'Less than a minute never shows zero'
Assert-Equal (Get-Countdown '2026-09-05T12:00:00Z' $now) 'renovando' 'Expired window keeps the compact countdown'
Assert-Equal (Get-Countdown 'invalid' $now) '' 'Invalid dates are handled'

$claude = [pscustomobject]@{provider='claude';label='Claude';status='unavailable';stale=$true;failureKind='auth';message='Session expired. Use /login.';collectedAt=$now.AddMinutes(-6).ToString('o');windows=@([pscustomobject]@{id='five_hour';usedPercent=93;resetsAt=$now.AddHours(-1).ToString('o')})}
$codex = [pscustomobject]@{provider='codex';label='Codex';status='ok';collectedAt=$now.ToString('o');windows=@([pscustomobject]@{id='seven_day';usedPercent=31;resetsAt=$now.AddHours(5).ToString('o')})}
$script:Snapshot = [pscustomobject]@{providers=@($claude,$codex)}
Assert-Equal (Get-WorstUsage $now).usedPercent 31 'Expired Claude cache does not control tray percentage'
Assert-Equal ((Get-TooltipText $now) -match 'Claude: indisponivel') $true 'Tooltip keeps failures compact'
$claude.status = 'ok'; $claude.failureKind = $null
Assert-Equal (Test-ProviderAttention $claude $now) $true 'Expired reset needs attention even with recent cache'
Assert-Equal (Test-ProviderOutdated $codex $now.AddMinutes(10)) $true 'A stopped daemon becomes visibly outdated'
$script:Snapshot = [pscustomobject]@{providers=@($codex)}
Assert-Equal ((Get-TooltipText $now) -match 'Codex') $true 'One provider renders correctly on PowerShell 5.1'
$antigravity = [pscustomobject]@{provider='antigravity';label='Antigravity';status='ok';collectedAt=$now.ToString('o');windows=@(
  [pscustomobject]@{id='antigravity_gemini_five_hour';shortLabel='Gem 5h';durationMinutes=300;usedPercent=80;resetsAt=$now.AddHours(5).ToString('o')},
  [pscustomobject]@{id='antigravity_claude_gpt_seven_day';shortLabel='C/G sem';durationMinutes=10080;usedPercent=0;resetsAt=$now.AddDays(7).ToString('o')}
)}
Assert-Equal (Get-WindowShortLabel $antigravity.windows[0]) 'Gem 5h' 'Antigravity distinguishes Gemini in compact rows'
Assert-Equal (Get-WindowShortLabel $antigravity.windows[1]) 'C/G sem' 'Antigravity distinguishes its Claude and GPT quota'
$script:Snapshot = [pscustomobject]@{providers=@($codex,$antigravity)}
Assert-Equal (Get-WorstUsage $now).usedPercent 80 'Antigravity participates in the tray percentage'
$script:Snapshot = [pscustomobject]@{providers=@($claude,$codex,$antigravity)}
Assert-Equal (Get-TooltipText $now) 'Claude: ? | Codex: 31% | Antigravity: 80%' 'Long tooltips retain all three providers and their highest valid usage'
$codex.status = 'unavailable'; $antigravity.status = 'unavailable'
Assert-Equal (Get-TooltipText $now) 'Claude: ? | Codex: ? | Antigravity: ?' 'Unavailable providers also fit within the Windows tooltip limit'
$codex.status = 'ok'
$codex.windows += @(
  [pscustomobject]@{id='codex_bengalfox_primary';shortLabel='Spark 5h';durationMinutes=300;usedPercent=40;resetsAt=$now.AddHours(5).ToString('o')},
  [pscustomobject]@{id='codex_bengalfox_secondary';shortLabel='Spark 7d';durationMinutes=10080;usedPercent=92;resetsAt=$now.AddDays(7).ToString('o')}
)
Assert-Equal (Get-WindowShortLabel $codex.windows[1]) 'Spark 5h' 'Spark five-hour quota has a compact distinct label'
Assert-Equal (Get-WindowShortLabel $codex.windows[2]) 'Spark 7d' 'Spark weekly quota has a compact distinct label'
Assert-Equal (Get-WorstUsage $now).usedPercent 92 'Spark can determine the tray percentage without being added to the Codex quota'
$codex.windows[2].resetsAt = $now.AddMinutes(-1).ToString('o')
Assert-Equal (Get-WorstUsage $now).usedPercent 40 'Expired Spark quota no longer controls the tray percentage'
Write-Output "$passed Windows tray checks passed."
