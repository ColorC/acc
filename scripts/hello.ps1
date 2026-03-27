#ACC: summary: "测试 Windows 脚本"
#ACC: param: name=msg type=string required=true desc="hello message"

param (
    [string]$msg
)

Write-Output "Hello from Windows: $msg"
