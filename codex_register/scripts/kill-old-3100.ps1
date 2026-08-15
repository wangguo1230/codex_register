# 启动前强杀旧 :3100 / server/index.ts，不走 Node 关窗收尾。
param([int]$Port = 3100)
$me = $PID
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'server[/\\]index\.ts|tsx server' } |
    ForEach-Object {
        if ($_.ProcessId -ne $me) {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
            Write-Output "killed node $($_.ProcessId)"
        }
    }
Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object {
        if ($_.OwningProcess -and $_.OwningProcess -ne $me) {
            Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
            Write-Output "killed port $($_.OwningProcess)"
        }
    }
