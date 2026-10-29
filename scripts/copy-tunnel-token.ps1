$ErrorActionPreference = 'Stop'

# Read the dashboard command from the local clipboard; never print or save the token.
Write-Host 'Now copy Install as service from Cloudflare using its copy button.'
[void](Read-Host 'Return to this window and press Enter after copying')
$clip = (Get-Clipboard -Raw).Trim()
$match = [regex]::Match($clip, '(?:^|\s)service\s+install\s+([A-Za-z0-9+/=_-]+)\s*$')
if (-not $match.Success) {
    throw 'Copy the full Install as service command from Cloudflare first.'
}
$token = $match.Groups[1].Value
try {
    $decoded = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($token)) | ConvertFrom-Json
    if (-not $decoded.a -or -not $decoded.t -or -not $decoded.s) { throw 'Unexpected token format.' }
} catch {
    throw 'The clipboard token is incomplete or invalid. Copy it again using the Cloudflare copy button.'
}

$commands = @("T=''")
for ($offset = 0; $offset -lt $token.Length; $offset += 60) {
    $part = $token.Substring($offset, [Math]::Min(60, $token.Length - $offset))
    $commands += "T+='$part'"
}
$commands += 'cloudflared service install "$T"'
$commands += 'unset T'
try {
    for ($index = 0; $index -lt $commands.Count; $index++) {
        Set-Clipboard -Value $commands[$index]
        Write-Host ('Step {0}/{1}: paste into the VPS console and press Enter there.' -f ($index + 1), $commands.Count)
        [void](Read-Host 'Then return here and press Enter for the next step')
    }
} finally {
    Set-Clipboard -Value ''
    $clip = $token = $decoded = $commands = $part = $match = $null
}
Write-Host 'Finished. Check the installation result in the VPS console.'
