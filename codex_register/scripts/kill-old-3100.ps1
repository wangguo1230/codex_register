# 启动前强杀旧 :3100 / server/index.ts，不走 Node 关窗收尾。
param([int]$Port = 3100)
$me = $PID
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
        $_.Name -match 'node|tsx' -and $_.CommandLine -and
        ($_.CommandLine -match 'server[/\\]index\.ts' -or $_.CommandLine -match 'tsx server')
    } |
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
