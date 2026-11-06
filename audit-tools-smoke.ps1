$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path $PSScriptRoot -Parent) 'audit-tools.ps1')
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('daytrip-audit-smoke-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path (Join-Path $tempRoot 'src') -Force | Out-Null
$fakeKey = 'gsk_TEST_SECRET_SHOULD_NOT_APPEAR'
[System.IO.File]::WriteAllText((Join-Path $tempRoot 'src/sample.ts'), ('x' * 120000))
[System.IO.File]::WriteAllText((Join-Path $tempRoot '.env'), "GROQ_API_KEY=$fakeKey")
$script:mockIssue = $true
$script:maxRequestBytes = 0

function Invoke-AuditTests([string]$root) { return @{status='PASS';command='mocked test runner';details='Deterministic smoke-test evidence.'} }
function Invoke-RestMethod {
    param($Uri,$Method,$Headers,$ContentType,$Body,$TimeoutSec,$ErrorAction)
    if ($Body.Length -gt $script:maxRequestBytes) { $script:maxRequestBytes=$Body.Length }
    $keys = @('frontend','backend','algorithm','api','security','quality','edgeCases')
    $categories = @($keys | ForEach-Object { @{key=$_;passedPoints=8;totalPoints=10;verifiedChecks=4;applicableChecks=5;evidence=@('Observed relevant implementation evidence.');notVerified=@('Live external call not run.')} })
    $issues = @(); $fixed = @()
    if ($script:mockIssue) { $issues = @(@{severity='MEDIUM';category='quality';title='Sample audit finding';description='Finding description';evidence='src/sample.ts';recommendation='Improve it';test='Add a test.'}) }
    $review = @{categoryEvidence=$categories;issues=$issues;fixedIssueIds=$fixed;majorRegression=$false;summary='Mocked independent review.'}
    return @{choices=@(@{message=@{content=(ConvertTo-Json -InputObject $review -Depth 12 -Compress)}})}
}

try {
    $request = [pscustomobject]@{Url=[uri]'http://localhost/api/audit/run';HttpMethod='POST';Headers=@{Origin='http://localhost'}}
    $firstResult = Get-AuditResponse $request $tempRoot $fakeKey 'openai/gpt-oss-120b'
    if ($firstResult.Status -ne 200) { throw "Baseline audit returned HTTP $($firstResult.Status)." }
    $first = $firstResult.Body.report
    if ($first.iteration -ne 1 -or [Math]::Abs($first.verifiedQualityScore - 80) -gt 0.01) { throw 'Weighted score or initial iteration is incorrect.' }
    if ($first.verificationCoverage -ne 80 -or $first.testStatus -ne 'PASS') { throw 'Coverage or test evidence was not recorded.' }
    if ($first.sourceChunksSent -ne 12 -or $script:maxRequestBytes -gt 30000) { throw 'Source batching failed to bound Groq request size.' }
    if ($first.remainingIssues.Count -ne 1 -or $first.remainingIssues[0].id -notmatch '^AUD-[A-F0-9]{10}$') { throw 'An issue did not receive a stable audit ID.' }
    if (@($first.fileManifest | Where-Object path -eq '.env').Count -gt 0) { throw 'The .env file was collected.' }
    $firstIssueId = $first.remainingIssues[0].id
    $firstHash = ($first.fileManifest | Where-Object path -eq 'src\sample.ts' | Select-Object -First 1).sha256
    [System.IO.File]::WriteAllText((Join-Path $tempRoot 'src/sample.ts'), 'export const value = 2;')
    $second = (Get-AuditResponse $request $tempRoot $fakeKey 'openai/gpt-oss-120b').Body.report
    $secondHash = ($second.fileManifest | Where-Object path -eq 'src\sample.ts' | Select-Object -First 1).sha256
    if ($second.iteration -ne 2 -or $second.previousQualityScore -ne 80 -or $second.remainingIssues[0].id -ne $firstIssueId) { throw 'Iteration or issue history was not preserved.' }
    if ($firstHash -eq $secondHash) { throw 'Changed project source did not change its recorded hash.' }
    if ($second.fileChanges.Count -ne 1 -or $second.fileChanges[0].change -ne 'modified') { throw 'The changed source file was not reported as a modification.' }

    $request.Headers['Origin'] = 'http://outside.invalid'
    if ((Get-AuditResponse $request $tempRoot $fakeKey 'openai/gpt-oss-120b').Status -ne 403) { throw 'Cross-origin request was not blocked.' }
    $request.Headers['Origin'] = 'http://localhost'
    if ((Get-AuditResponse $request $tempRoot '' 'openai/gpt-oss-120b').Status -ne 503) { throw 'Missing critic key was not handled safely.' }
    $reportText = (Get-ChildItem (Join-Path $tempRoot 'audit-reports') -File | ForEach-Object { [System.IO.File]::ReadAllText($_.FullName) }) -join '|'
    if ($reportText.Contains($fakeKey)) { throw 'A credential value leaked into an audit report.' }
    1..8 | ForEach-Object { $n=$_+2; [System.IO.File]::WriteAllText((Join-Path (Join-Path $tempRoot 'audit-reports') ('iteration-{0:D3}.json' -f $n)), (ConvertTo-Json @{iteration=$n} -Compress)) }
    if ((Get-AuditResponse $request $tempRoot $fakeKey 'openai/gpt-oss-120b').Status -ne 409) { throw 'The ten-iteration cap was not enforced.' }
    Write-Output 'PowerShell audit smoke checks passed.'
} finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
