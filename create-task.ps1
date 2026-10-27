$projectId = "e405de72-89a5-4151-931c-248fb6b8ef87"
$agentId = "developer_$projectId"
$idempotencyKey = "demo-task-001"

$payload = @{
    project_id = $projectId
    agent_id = $agentId
    title = "Demo Task"
    description = "Created via PowerShell API test"
    idempotency_key = $idempotencyKey
} | ConvertTo-Json

Invoke-RestMethod -Uri "http://127.0.0.1:3737/api/tasks" -Method Post -Body $payload -ContentType "application/json"