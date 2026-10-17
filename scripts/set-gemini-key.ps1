# Prompts for a Gemini API key and saves it into .env (never printed, never committed).
$envFile = Join-Path $PSScriptRoot '..\.env'
if (-not (Test-Path $envFile)) { Copy-Item (Join-Path $PSScriptRoot '..\.env.example') $envFile }

$secure = Read-Host 'Paste your Gemini API key, then press Enter' -AsSecureString
$key = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)).Trim()
if (-not $key) { Write-Host 'No key entered. Nothing changed.' -ForegroundColor Yellow; return }

$lines = Get-Content $envFile | ForEach-Object { if ($_ -match '^GEMINI_API_KEY=') { "GEMINI_API_KEY=$key" } else { $_ } }
[IO.File]::WriteAllLines((Resolve-Path $envFile), $lines, (New-Object Text.UTF8Encoding $false))
Write-Host "Saved. Key ends in ...$($key.Substring([Math]::Max(0, $key.Length - 4)))" -ForegroundColor Green
