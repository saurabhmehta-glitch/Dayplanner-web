function Get-AuditHistory([string]$root) {
    $reportRoot = Join-Path $root 'audit-reports'
    if (-not (Test-Path -LiteralPath $reportRoot -PathType Container)) { return @() }
    $reports = @()
    foreach ($file in Get-ChildItem -LiteralPath $reportRoot -Filter 'iteration-*.json' -File | Sort-Object Name) {
        try { $reports += (Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json -ErrorAction Stop) } catch { }
    }
    return @($reports | Sort-Object iteration)
}

function Get-AuditFiles([string]$root, [string]$apiKey) {
    $allowed = @('*.ts','*.tsx','*.js','*.jsx','*.css','*.html','*.json','*.md','*.ps1','*.bat','*.example')
    $skipNames = @('.git','.codex','.agents','node_modules','dist','audit-reports','.vscode')
    $files = @()
    foreach ($pattern in $allowed) {
        foreach ($file in Get-ChildItem -LiteralPath $root -Filter $pattern -File -Recurse -Force -ErrorAction SilentlyContinue) {
            $relative = $file.FullName.Substring($root.Length).TrimStart('\','/')
            $segments = $relative -split '[\\/]'
            $baseName = [System.IO.Path]::GetFileName($relative)
            $isEnvSecret = $baseName -eq '.env' -or ($baseName.StartsWith('.env.') -and $baseName -ne '.env.example')
            if (@($segments | Where-Object { $_ -in $skipNames }).Count -gt 0 -or $isEnvSecret) { continue }
            if ($file.Length -gt 180000) { continue }
            try {
                $raw = [System.IO.File]::ReadAllText($file.FullName)
                if ($apiKey) { $raw = $raw.Replace($apiKey, '[REDACTED]') }
                $raw = [regex]::Replace($raw, '(?im)(GROQ_API_KEY|OPENWEATHER_API_KEY|TAVILY_API_KEY|OPENAI_API_KEY)\s*[=:]\s*[^\r\n]+', '$1=[REDACTED]')
                $raw = [regex]::Replace($raw, '(?i)gsk_[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{16,}', '[REDACTED]')
                if ($relative -eq 'package-lock.json') {
                    $lock = $raw | ConvertFrom-Json -ErrorAction Stop
                    $raw = (@($lock.packages.PSObject.Properties | Where-Object { $_.Name -like 'node_modules/*' } | ForEach-Object { "$($_.Name) $($_.Value.version)" }) -join "`n")
                }
                $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
                $files += [pscustomobject]@{ path=$relative; sha256=$hash; content=$raw }
            } catch { }
        }
    }
    return @($files | Sort-Object path -Unique)
}

function New-AuditBatches($files, [int]$maxChars = 28000) {
    $batches = [System.Collections.Generic.List[object]]::new(); $current = [System.Collections.Generic.List[object]]::new(); $currentChars = 0
    foreach ($file in $files) {
        $content = [string]$file.content
        if ($content.Length -eq 0) { continue }
        for ($offset=0; $offset -lt $content.Length; $offset += $maxChars) {
            $length=[Math]::Min($maxChars,$content.Length-$offset)
            if ($currentChars -gt 0 -and ($currentChars+$length) -gt $maxChars) { $batches.Add([pscustomobject]@{files=$current.ToArray()});$current.Clear();$currentChars=0 }
            $fragment=$content.Substring($offset,$length)
            $current.Add(@{path=$file.path;sha256=$file.sha256;characterRange="$offset-$($offset+$length)";content=$fragment})
            $currentChars += $length
            if ($currentChars -ge $maxChars) { $batches.Add([pscustomobject]@{files=$current.ToArray()});$current.Clear();$currentChars=0 }
        }
    }
    if ($current.Count -gt 0) { $batches.Add([pscustomobject]@{files=$current.ToArray()}) }
    return $batches.ToArray()
}

function Get-AuditFailure([int]$status, [string]$code, [string]$message) {
    return @{ Status=$status; Body=@{code=$code;message=$message} }
}

function Invoke-AuditTests([string]$root) {
    $node = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $node) { return @{status='NOT VERIFIED';command='node --test';details='Node.js is not installed; the local launcher does not require it.'} }
    $stdout = Join-Path ([System.IO.Path]::GetTempPath()) ('daytrip-audit-test-'+[guid]::NewGuid().ToString('N')+'.out')
    $stderr = Join-Path ([System.IO.Path]::GetTempPath()) ('daytrip-audit-test-'+[guid]::NewGuid().ToString('N')+'.err')
    $process = $null
    try {
        $process = Start-Process -FilePath $node.Source -ArgumentList @('--test') -WorkingDirectory $root -PassThru -NoNewWindow -RedirectStandardOutput $stdout -RedirectStandardError $stderr
        if (-not $process.WaitForExit(90000)) { try { $process.Kill() } catch { }; return @{status='TIMEOUT';command='node --test';details='Automated tests exceeded the 90-second audit limit.'} }
        $output='';if(Test-Path -LiteralPath $stdout){$output += [System.IO.File]::ReadAllText($stdout)};if(Test-Path -LiteralPath $stderr){$output += [System.IO.File]::ReadAllText($stderr)}
        if ($output.Length -gt 10000) { $output=$output.Substring($output.Length-10000) }
        $status='FAIL';if($process.ExitCode -eq 0){$status='PASS'}
        return @{status=$status;command='node --test';exitCode=$process.ExitCode;details=$output.Trim()}
    } catch { return @{status='ERROR';command='node --test';details='Automated tests could not be started.'} }
    finally { Remove-Item -LiteralPath $stdout,$stderr -Force -ErrorAction SilentlyContinue }
}

function Invoke-GroqCritic([string]$body, [string]$apiKey) {
    for ($attempt=0; $attempt -le 5; $attempt++) {
        try {
            return Invoke-RestMethod -Uri 'https://api.groq.com/openai/v1/chat/completions' -Method Post -Headers @{Authorization="Bearer $apiKey"} -ContentType 'application/json' -Body $body -TimeoutSec 120 -ErrorAction Stop
        } catch {
            $upstreamStatus=0;try{if($_.Exception.Response){$upstreamStatus=[int]$_.Exception.Response.StatusCode}}catch{}
            if ($upstreamStatus -ne 429 -or $attempt -ge 5) { throw }
            $delay=60;try{$header=[string]$_.Exception.Response.Headers['Retry-After'];if($header -match '^\d+(\.\d+)?$'){$delay=[Math]::Max(1,[Math]::Min(60,[Math]::Ceiling([double]$header)))}}catch{}
            Write-Host "Groq rate limit reached; retrying the critic request in $delay seconds." -ForegroundColor Yellow
            Start-Sleep -Seconds $delay
        }
    }
}

function Get-AuditResponse($request, [string]$root, [string]$apiKey, [string]$criticModel) {
    if ($request.Url.Host -notin @('localhost','127.0.0.1','[::1]')) { return Get-AuditFailure 403 'local_only' 'Audit tools are available only on this computer.' }
    if ($request.Url.AbsolutePath -eq '/api/audit/history') {
        if ($request.HttpMethod -ne 'GET') { return Get-AuditFailure 405 'method_not_allowed' 'Use GET to read audit history.' }
        return @{ Status=200; Body=@{reports=(Get-AuditHistory $root)} }
    }
    if ($request.Url.AbsolutePath -ne '/api/audit/run') { return Get-AuditFailure 404 'not_found' 'Unknown audit endpoint.' }
    if ($request.HttpMethod -ne 'POST') { return Get-AuditFailure 405 'method_not_allowed' 'Use POST to start an audit.' }
    $origin = $request.Headers['Origin']
    if ($origin -and $origin -ne $request.Url.GetLeftPart([System.UriPartial]::Authority)) { return Get-AuditFailure 403 'invalid_origin' 'Audit requests must come from this local dashboard.' }
    if ([string]::IsNullOrWhiteSpace($apiKey)) { return Get-AuditFailure 503 'critic_not_configured' 'Add GROQ_API_KEY to the local .env file to run an independent audit.' }

    $reports = @(Get-AuditHistory $root)
    if ($reports.Count -ge 10) { return Get-AuditFailure 409 'iteration_limit' 'The ten-iteration limit has been reached. Review the final report before starting a new audit series.' }
    $iteration = $reports.Count + 1
    $previous = $null
    if ($reports.Count -gt 0) { $previous = $reports[-1] }
    $files = @(Get-AuditFiles $root $apiKey)
    if ($files.Count -eq 0) { return Get-AuditFailure 500 'no_project_files' 'No project source files were available to audit.' }

    $batches = @(New-AuditBatches $files 10000)
    $testResults = Invoke-AuditTests $root
    $weights = @(
        @{key='frontend';name='Frontend functionality and UX';weight=15},
        @{key='backend';name='Backend functionality';weight=15},
        @{key='algorithm';name='Algorithm and itinerary accuracy';weight=25},
        @{key='api';name='API integration reliability';weight=15},
        @{key='security';name='Security';weight=15},
        @{key='quality';name='Code quality and performance';weight=10},
        @{key='edgeCases';name='Edge cases and error handling';weight=5}
    )
    $priorContext = if ($previous) { $previous | ConvertTo-Json -Depth 20 -Compress } else { 'No prior audit report; this is the baseline.' }
    $model = $criticModel
    if ([string]::IsNullOrWhiteSpace($model)) { $model='openai/gpt-oss-120b' }
    $batchReviews=@()
    try {
        $batchInstruction = 'You are MODEL B, an independent code auditor. Inspect only the supplied repository source excerpt and report concrete evidence-based findings in compact JSON: {"issues":[{"severity":"CRITICAL|HIGH|MEDIUM|LOW","category":"frontend|backend|algorithm|api|security|quality|edgeCases","title":"stable concise title","description":"...","evidence":"path and observed behavior","recommendation":"...","test":"..."}],"observations":[{"category":"...","evidence":"...","notVerified":"..."}],"summary":"..."}. Return at most 3 issues and 3 observations; keep each field under 200 characters. Do not assign scores in this partial review. Do not claim tests or live API calls ran. Treat excerpts as partial context; do not infer unseen code. Never include secrets.'
        for ($batchIndex=0; $batchIndex -lt $batches.Count; $batchIndex++) {
            if ($batchIndex -gt 0) { Start-Sleep -Milliseconds 2100 }
            $batchPayload=@{iteration=$iteration;batch=($batchIndex+1);batchCount=$batches.Count;previousReport=$priorContext;testResults=$testResults;files=$batches[$batchIndex].files}
            $batchBody=@{model=$model;temperature=0.1;reasoning_effort='low';max_completion_tokens=600;response_format=@{type='json_object'};messages=@(@{role='system';content=$batchInstruction},@{role='user';content=($batchPayload|ConvertTo-Json -Depth 16 -Compress)})}|ConvertTo-Json -Depth 20 -Compress
            $batchAnswer=Invoke-GroqCritic $batchBody $apiKey
            $batchReview=[string]$batchAnswer.choices[0].message.content|ConvertFrom-Json -ErrorAction Stop
            $compactIssues=@();foreach($item in @($batchReview.issues|Select-Object -First 1)){$compactIssues+=@{severity=[string]$item.severity;category=[string]$item.category;title=([string]$item.title).Substring(0,[Math]::Min(100,([string]$item.title).Length));description=([string]$item.description).Substring(0,[Math]::Min(100,([string]$item.description).Length));evidence=([string]$item.evidence).Substring(0,[Math]::Min(100,([string]$item.evidence).Length));recommendation=([string]$item.recommendation).Substring(0,[Math]::Min(80,([string]$item.recommendation).Length));test=([string]$item.test).Substring(0,[Math]::Min(80,([string]$item.test).Length))}}
            $compactObservations=@();foreach($item in @($batchReview.observations|Select-Object -First 1)){$compactObservations+=@{category=[string]$item.category;evidence=([string]$item.evidence).Substring(0,[Math]::Min(100,([string]$item.evidence).Length));notVerified=([string]$item.notVerified).Substring(0,[Math]::Min(80,([string]$item.notVerified).Length))}}
            $summary=[string]$batchReview.summary;if($summary.Length -gt 150){$summary=$summary.Substring(0,150)}
            $batchReviews+=@{batch=($batchIndex+1);review=@{issues=$compactIssues;observations=$compactObservations;summary=$summary}}
        }
        $finalInstruction = @'
You are MODEL B, an independent code critic preparing the final complete-repository audit from all supplied source inspections and test evidence. Do not claim execution of tests or live APIs unless testResults explicitly contain those results. Treat unavailable checks as NOT VERIFIED. Do not assume an API credential exists, and never repeat, infer, or include secrets. Inspect prior issues and retest their fixes using the current batch findings. Return one JSON object only, no markdown, with this schema:
{"categoryEvidence":[{"key":"frontend|backend|algorithm|api|security|quality|edgeCases","passedPoints":0,"totalPoints":0,"verifiedChecks":0,"applicableChecks":0,"evidence":["file/function and observed evidence"],"notVerified":["unrun checks"]}],"issues":[{"severity":"CRITICAL|HIGH|MEDIUM|LOW","category":"...","title":"...","description":"...","evidence":"file and relevant behavior","recommendation":"...","test":"..."}],"fixedIssueIds":["..."],"majorRegression":false,"summary":"..."}.
Give points only for demonstrated evidence from the source inspections and test results. For each category, totalPoints must be positive and no larger than 100; passedPoints cannot exceed totalPoints. verifiedChecks is the number of applicable checks actually verified; applicableChecks is the full number considered. Unverified checks do not earn score. API verification must distinguish code inspection from live provider verification. Deduplicate repeated findings. Keep issue titles concise and stable. Report all unresolved issues. A previous issue may be marked fixed only when current source evidence supports it.
'@
        $finalPayload=@{iteration=$iteration;previousReport=$priorContext;testResults=$testResults;categoryWeights=$weights;fileManifest=@($files|ForEach-Object{@{path=$_.path;sha256=$_.sha256}});sourceInspections=$batchReviews}
        $finalBody=@{model=$model;temperature=0.1;reasoning_effort='low';max_completion_tokens=2500;response_format=@{type='json_object'};messages=@(@{role='system';content=$finalInstruction},@{role='user';content=($finalPayload|ConvertTo-Json -Depth 24 -Compress)})}|ConvertTo-Json -Depth 26 -Compress
        $finalAnswer=Invoke-GroqCritic $finalBody $apiKey
        $review=[string]$finalAnswer.choices[0].message.content|ConvertFrom-Json -ErrorAction Stop
    } catch {
        $status = 502
        $upstreamStatus = 0
        try { if ($_.Exception.Response) { $upstreamStatus=[int]$_.Exception.Response.StatusCode } } catch { }
        $safeFailure = [string]$_.Exception.Message
        if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $safeFailure=[string]$_.ErrorDetails.Message }
        if ($apiKey) { $safeFailure=$safeFailure.Replace($apiKey,'[REDACTED]') }
        $safeFailure=[regex]::Replace($safeFailure,'(?i)gsk_[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{16,}','[REDACTED]')
        if ($safeFailure.Length -gt 240) { $safeFailure=$safeFailure.Substring(0,240) }
        $requestBytes=0;if($batchBody){$requestBytes=[System.Text.Encoding]::UTF8.GetByteCount($batchBody)};if($finalBody){$requestBytes=[System.Text.Encoding]::UTF8.GetByteCount($finalBody)}
        Write-Warning "Groq audit request failed (HTTP $upstreamStatus; $($_.Exception.GetType().Name); request ${requestBytes} bytes): $safeFailure"
        if ($upstreamStatus -eq 401) { return Get-AuditFailure 503 'critic_credentials_invalid' 'Groq rejected the configured critic credentials. Check GROQ_API_KEY; the credential was not included in this response.' }
        if ($upstreamStatus -eq 404) { return Get-AuditFailure 503 'critic_model_unavailable' 'Groq could not find the configured critic model. Check AUDIT_CRITIC_MODEL.' }
        if ($upstreamStatus -eq 400) { return Get-AuditFailure 502 'critic_request_rejected' 'Groq rejected the audit request. Check the model configuration and request compatibility.' }
        return Get-AuditFailure 502 'critic_unavailable' 'The independent critic did not return a valid audit. Check provider availability and retry; no audit report was saved.'
    }
    if (-not $review.categoryEvidence -or $null -eq $review.issues) { return Get-AuditFailure 502 'invalid_critic_response' 'The critic response did not match the required audit structure. No report was saved.' }

    $categoryScores = @(); $weighted = 0.0; $verifiedChecks=0.0; $applicableChecks=0.0
    foreach ($category in $weights) {
        $evidence = @($review.categoryEvidence | Where-Object { $_.key -eq $category.key } | Select-Object -First 1)
        if ($evidence.Count -eq 0) { $categoryScores += @{key=$category.key;name=$category.name;weight=$category.weight;score=$null;status='NOT VERIFIED';passedPoints=0;totalPoints=0;verifiedChecks=0;applicableChecks=0;evidence=@();notVerified=@('Critic omitted category evidence.')}; continue }
        $pass = [Math]::Max(0,[double]$evidence[0].passedPoints); $total = [Math]::Max(0,[double]$evidence[0].totalPoints)
        if ($total -gt 100) { $total=100 }; if ($pass -gt $total) { $pass=$total }
        $score = $null; $categoryStatus='NOT VERIFIED'
        $checked=[Math]::Max(0,[double]$evidence[0].verifiedChecks);$applicable=[Math]::Max(0,[double]$evidence[0].applicableChecks);if($applicable -gt 1000){$applicable=1000};if($checked -gt $applicable){$checked=$applicable};$verifiedChecks+=$checked;$applicableChecks+=$applicable
        if ($total -gt 0) { $score=[Math]::Round(100*$pass/$total,2);$categoryStatus='VERIFIED';$weighted += ($score*$category.weight/100) }
        $categoryScores += @{key=$category.key;name=$category.name;weight=$category.weight;score=$score;status=$categoryStatus;passedPoints=$pass;totalPoints=$total;verifiedChecks=$checked;applicableChecks=$applicable;evidence=@($evidence[0].evidence);notVerified=@($evidence[0].notVerified)}
    }
    $quality = 0.0
    $quality=[Math]::Round($weighted,2)
    $coverage=0.0
    if ($applicableChecks -gt 0) { $coverage=[Math]::Round(100*$verifiedChecks/$applicableChecks,2) }
    $issues = @(); $previousOpen=@()
    if ($previous -and $previous.remainingIssues) { $previousOpen=@($previous.remainingIssues) }
    foreach ($issue in @($review.issues)) {
        $title=[string]$issue.title; $categoryName=[string]$issue.category
        $matched=$previousOpen | Where-Object { ([string]$_.title).Trim().ToLowerInvariant() -eq $title.Trim().ToLowerInvariant() -and ([string]$_.category).Trim().ToLowerInvariant() -eq $categoryName.Trim().ToLowerInvariant() } | Select-Object -First 1
        $id=''
        if ($matched) { $id=[string]$matched.id }
        if ([string]::IsNullOrWhiteSpace($id)) { $bytes=[System.Text.Encoding]::UTF8.GetBytes(($categoryName+'|'+$title.Trim().ToLowerInvariant()));$sha=[System.Security.Cryptography.SHA256]::Create();try{$digest=$sha.ComputeHash($bytes)}finally{$sha.Dispose()};$id='AUD-'+(([BitConverter]::ToString($digest).Replace('-','')).Substring(0,10)) }
        $severity=[string]$issue.severity;if($severity -notin @('CRITICAL','HIGH','MEDIUM','LOW')){$severity='MEDIUM'}
        $issues += @{id=$id;severity=$severity;category=$categoryName;title=$title;description=[string]$issue.description;evidence=[string]$issue.evidence;recommendation=[string]$issue.recommendation;test=[string]$issue.test}
    }
    $remaining = @($issues | Sort-Object id -Unique)
    $fixed = @($review.fixedIssueIds | ForEach-Object { [string]$_ } | Where-Object { $_ -match '^AUD-[A-Fa-f0-9]{10}$' } | Sort-Object -Unique)
    $fixed = @($fixed | Where-Object { $id=$_; -not ($remaining | Where-Object { $_.id -eq $id }) })
    $critical = @($remaining | Where-Object { $_.severity -eq 'CRITICAL' }).Count
    $high = @($remaining | Where-Object { $_.severity -eq 'HIGH' }).Count
    $testStatus=[string]$testResults.status;$stop='In progress'
    $apiCategory=@($categoryScores | Where-Object { $_.key -eq 'api' } | Select-Object -First 1)
    $apiVerified=$apiCategory.Count -gt 0 -and $null -ne $apiCategory[0].score -and @($apiCategory[0].notVerified).Count -eq 0
    if ($quality -ge 90 -and $critical -eq 0 -and $high -eq 0 -and -not $review.majorRegression -and $testStatus -eq 'PASS' -and $apiVerified) { $stop='Complete' }
    elseif ($quality -ge 90 -and $critical -eq 0 -and $high -eq 0 -and -not $review.majorRegression) { $stop='Score threshold met; core test and API verification still required' }
    if ($iteration -ge 10 -and $stop -ne 'Complete') { $stop='Maximum iterations reached' }
    $previousScore=$null;if($previous){$previousScore=$previous.verifiedQualityScore}
    $fileManifest=@($files | ForEach-Object {@{path=$_.path;sha256=$_.sha256}})
    $previousHashes=@{};if($previous -and $previous.fileManifest){foreach($item in @($previous.fileManifest)){$previousHashes[[string]$item.path]=[string]$item.sha256}}
    $fileChanges=@()
    foreach($item in $fileManifest){$path=[string]$item.path;if(-not $previous){$fileChanges+=@{path=$path;change='baseline'}}elseif(-not $previousHashes.ContainsKey($path)){$fileChanges+=@{path=$path;change='added'}}elseif($previousHashes[$path] -ne [string]$item.sha256){$fileChanges+=@{path=$path;change='modified'}}}
    foreach($oldPath in $previousHashes.Keys){if(-not (@($fileManifest|Where-Object{$_.path -eq $oldPath}).Count)){$fileChanges+=@{path=[string]$oldPath;change='removed'}}}
    $report=@{
        timestamp=[DateTime]::UtcNow.ToString('o');iteration=$iteration;phase=$(if($iteration -eq 1){'baseline'}else{'follow-up'});primaryModel='Codex GPT-6 (interactive session; not called by this endpoint)';criticModel=$model
        previousQualityScore=$previousScore;verifiedQualityScore=$quality;verificationCoverage=$coverage;categoryScores=$categoryScores
        issues=$remaining;fixedIssueIds=$fixed;remainingIssues=$remaining;issueCounts=@{critical=$critical;high=$high;medium=@($remaining|Where-Object severity -eq 'MEDIUM').Count;low=@($remaining|Where-Object severity -eq 'LOW').Count}
        testResults=$testResults;testStatus=$testStatus;majorRegression=[bool]$review.majorRegression;criticSummary=[string]$review.summary;fileManifest=$fileManifest;fileChanges=$fileChanges;sourceFileCount=$files.Count;sourceChunksSent=$batches.Count;sourceTruncated=$false;stopStatus=$stop
    }
    $reportRoot=Join-Path $root 'audit-reports';if(-not(Test-Path -LiteralPath $reportRoot)){New-Item -ItemType Directory -Path $reportRoot -Force|Out-Null}
    $reportPath=Join-Path $reportRoot ('iteration-{0:D3}.json' -f $iteration)
    $json=ConvertTo-Json -InputObject $report -Depth 24
    if ($apiKey) { $json=$json.Replace($apiKey,'[REDACTED]') }
    $json=[regex]::Replace($json,'(?i)gsk_[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{16,}','[REDACTED]')
    [System.IO.File]::WriteAllText($reportPath,$json,[System.Text.UTF8Encoding]::new($false))
    if ($iteration -ge 10) { [System.IO.File]::WriteAllText((Join-Path $reportRoot 'final-report.json'),$json,[System.Text.UTF8Encoding]::new($false)) }
    $safeReport=$json|ConvertFrom-Json -ErrorAction Stop
    return @{Status=200;Body=@{report=$safeReport}}
}
