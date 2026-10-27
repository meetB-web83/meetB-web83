$projectId = "e405de72-89a5-4151-931c-248fb6b8ef87"
$taskId = "6b4597fe-29f3-4d3e-97b7-c8634e07221f"
$idempotencyKey = "claim-demo-task-001"

$payload = @{
    project_id = $projectId
    title = "Demo Task"
    idempotency_key = $idempotencyKey
} | ConvertTo-Json

Invoke-RestMethod -Uri "http://127.0.0.1:3737/api/tasks/$taskId/claim" -Method Post -Body $payload -ContentType "application/json"