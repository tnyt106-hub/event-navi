# daily-update.ps1
# 堅牢・冪等・ログ強化版（2026-02）

$ErrorActionPreference = "Stop"

# UTF-8 出力（画面 & ログ）
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$RepoDir = "C:\Users\tnyt1\event-navi"
Set-Location $RepoDir

# ログ準備
$LogDir = "logs"
if (!(Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }

$TS  = Get-Date -Format "yyyyMMdd_HHmmss"
$Log = Join-Path $LogDir "daily-update_$TS.log"

function Write-Log([string]$msg) {
    Write-Host $msg
    $msg | Out-File -FilePath $Log -Append -Encoding utf8
}

function Run-Cmd([string]$command) {
    Write-Log ">>> $command"
    Write-Log "---- OUTPUT START ----"

    # Start-Process で exit code を確実に拾う
    $proc = Start-Process -FilePath "cmd.exe" `
        -ArgumentList "/c $command" `
        -NoNewWindow -PassThru -Wait

    # 標準出力・標準エラーをログに反映
    if ($proc.StandardOutput) {
        $proc.StandardOutput.ReadToEnd() | ForEach-Object {
            Write-Log $_
        }
    }
    if ($proc.StandardError) {
        $proc.StandardError.ReadToEnd() | ForEach-Object {
            Write-Log $_
        }
    }

    Write-Log "---- OUTPUT END ----"

    if ($proc.ExitCode -ne 0) {
        throw "Command failed (exit=$($proc.ExitCode)): $command"
    }
}

Write-Log "=== START ==="
Write-Log "Repo: $RepoDir"
Write-Log "Log:  $Log"

# ---- git pull ----
Write-Log "==== git pull ===="
Run-Cmd "git pull --ff-only origin main"

# ---- run-all ----
Write-Log "==== run-all ===="
Run-Cmd "node --unhandled-rejections=strict scripts\common\run-all.js"

# ---- docs 配下の変更確認（Git の diff に統一）----
cmd /c "git diff --quiet docs"
if ($LASTEXITCODE -eq 0) {
    Write-Log "[OK] No changes under docs/. Nothing to commit/push."
    exit 0
}

# ---- git add ----
Write-Log "==== git add ===="
Run-Cmd "git add docs"

# ---- ステージされた変更があるか確認 ----
cmd /c "git diff --cached --quiet"
if ($LASTEXITCODE -eq 0) {
    Write-Log "[OK] No staged changes. Skip commit/push."
    exit 0
}

# ---- git commit ----
$today = Get-Date -Format "yyyy-MM-dd"
Write-Log "==== git commit ===="
Run-Cmd "git commit -m ""chore: daily event update ($today)"""

# ---- IndexNow 送信 ----
Write-Log "==== IndexNow ===="

# 変更されたファイル一覧を取得（docs/ 以下のみ）
$changedFiles = git diff --name-only HEAD~1 HEAD docs | Where-Object { $_ -match "\.html$" }

if ($changedFiles.Count -eq 0) {
    Write-Log "[OK] No updated HTML files. Skip IndexNow."
} else {
    Write-Log "Updated files:"
    $changedFiles | ForEach-Object { Write-Log " - $_" }

 # URL へ変換
$urls = $changedFiles | ForEach-Object {
    # 1. すべての \ を / に統一
    $normalizedPath = $_.Replace("\", "/")
    
    # 2. 先頭の docs/ を削除
    $relativePath = $normalizedPath -replace "^docs/", ""
    
    # 3. 末尾の index.html または .html を適切に処理
    # IndexNowは完全なURLを推奨するため、拡張子を消す場合はリダイレクト設定と合わせる必要があります。
    # ここではログの意図に合わせて .html を消去します。
    $finalPath = $relativePath -replace "\.html$", ""
    
    "https://event-guide.jp/$finalPath"
}

    Write-Log "Sending URLs:"
    $urls | ForEach-Object { Write-Log " - $_" }

    # IndexNow JSON body
    $body = @{
        host        = "event-guide.jp"
        key         = $env:INDEXNOW_KEY
        keyLocation = "https://event-guide.jp/24922f4fdb33465987e52d25249516a1.txt"
        urlList     = $urls
    } | ConvertTo-Json -Depth 5

    try {
        $response = Invoke-RestMethod `
            -Uri "https://api.indexnow.org/IndexNow" `
            -Method Post `
            -ContentType "application/json; charset=utf-8" `
            -Body $body

        Write-Log "[OK] IndexNow response:"
        Write-Log ($response | Out-String)
    }
    catch {
        Write-Log "[ERROR] IndexNow failed: $_"
        throw $_
    }
}


# ---- git push ----
Write-Log "==== git push ===="
Run-Cmd "git push origin main"

Write-Log "[OK] Done."
exit 0
