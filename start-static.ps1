$ErrorActionPreference = 'Stop'

$distRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'dist'))
$indexPath = Join-Path $distRoot 'index.html'
$port = 5173
$openWeatherKey = $null
$groqApiKey = $null
$tavilyApiKey = $null
$auditCriticModel = $null
$envPath = Join-Path $PSScriptRoot '.env'
if (Test-Path -LiteralPath $envPath -PathType Leaf) {
    foreach ($line in Get-Content -LiteralPath $envPath) {
        if ($line.StartsWith('OPENWEATHER_API_KEY=')) { $openWeatherKey = $line.Substring('OPENWEATHER_API_KEY='.Length).Trim() }
        if ($line.StartsWith('GROQ_API_KEY=')) { $groqApiKey = $line.Substring('GROQ_API_KEY='.Length).Trim() }
        if ($line.StartsWith('TAVILY_API_KEY=')) { $tavilyApiKey = $line.Substring('TAVILY_API_KEY='.Length).Trim() }
        if ($line.StartsWith('AUDIT_CRITIC_MODEL=')) { $auditCriticModel = $line.Substring('AUDIT_CRITIC_MODEL='.Length).Trim() }
    }
}
if (-not $openWeatherKey) { $openWeatherKey = $env:OPENWEATHER_API_KEY }
if (-not $groqApiKey) { $groqApiKey = $env:GROQ_API_KEY }
if (-not $tavilyApiKey) { $tavilyApiKey = $env:TAVILY_API_KEY }
if (-not [string]::IsNullOrWhiteSpace($env:AUDIT_CRITIC_MODEL)) { $auditCriticModel = $env:AUDIT_CRITIC_MODEL }
if ([string]::IsNullOrWhiteSpace($auditCriticModel)) { $auditCriticModel = 'openai/gpt-oss-120b' }
. (Join-Path $PSScriptRoot 'audit-tools.ps1')

[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12

function Get-WeatherResponse($request) {
    if ($request.HttpMethod -ne 'GET') {
        return [pscustomobject]@{ Status = 405; Body = @{ code = 'method_not_allowed'; message = 'Use GET for weather.' } }
    }
    $destination = ([string]$request.QueryString['destination']).Trim()
    $date = [string]$request.QueryString['date']
    if ([string]::IsNullOrWhiteSpace($destination)) {
        return [pscustomobject]@{ Status = 400; Body = @{ code = 'destination_required'; message = 'Enter a destination to check its weather.' } }
    }
    if ($destination.Length -gt 150) { $destination = $destination.Substring(0, 150) }
    try { $null = [datetime]::ParseExact($date, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture) }
    catch { return [pscustomobject]@{ Status = 400; Body = @{ code = 'invalid_date'; message = 'A valid trip date is required.' } } }
    if ([string]::IsNullOrWhiteSpace($openWeatherKey)) {
        return [pscustomobject]@{ Status = 503; Body = @{ code = 'not_configured'; message = 'Add OPENWEATHER_API_KEY to the local .env file to enable live weather.' } }
    }

    try {
        $encodedDestination = [uri]::EscapeDataString($destination)
        $geoUri = "https://api.openweathermap.org/geo/1.0/direct?q=$encodedDestination&limit=5&appid=$openWeatherKey"
        $locations = Invoke-RestMethod -Uri $geoUri -TimeoutSec 8 -ErrorAction Stop
        if (-not $locations -or $locations.Count -eq 0) {
            return [pscustomobject]@{ Status = 404; Body = @{ code = 'location_not_found'; message = 'OpenWeather could not find that destination. Try adding a region or country.' } }
        }
        $distinctRegions = @($locations | ForEach-Object { "$($_.name)|$($_.state)|$($_.country)" } | Select-Object -Unique)
        if ($distinctRegions.Count -gt 1) {
            return [pscustomobject]@{ Status = 422; Body = @{ code = 'ambiguous_location'; message = 'This destination matches multiple places. Add a state or country and try again.' } }
        }
        $place = @($locations)[0]
        $coordinates = "lat=$($place.lat)&lon=$($place.lon)&appid=$openWeatherKey&units=metric"
        $current = Invoke-RestMethod -Uri "https://api.openweathermap.org/data/2.5/weather?$coordinates" -TimeoutSec 8 -ErrorAction Stop
        if ($null -eq $current.main.temp) { throw 'Current weather payload is incomplete.' }

        $forecastData = $null
        try { $forecastData = Invoke-RestMethod -Uri "https://api.openweathermap.org/data/2.5/forecast?$coordinates" -TimeoutSec 8 -ErrorAction Stop }
        catch { $forecastData = $null }

        $forecastSummary = $null
        $forecastStatus = 'unavailable'
        if ($forecastData -and $forecastData.list) {
            $offsetSeconds = [int]$forecastData.city.timezone
            $tripSamples = @($forecastData.list | Where-Object {
                $localTime = [DateTimeOffset]::FromUnixTimeSeconds([long]$_.dt).ToOffset([TimeSpan]::FromSeconds($offsetSeconds))
                $localTime.ToString('yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture) -eq $date
            })
            if ($tripSamples.Count -eq 0) {
                $forecastStatus = 'outside-range'
            } else {
                $temperatures = @()
                $rainChance = 0.0
                $noonSample = $tripSamples[0]
                $nearestNoonDistance = 24
                foreach ($sample in $tripSamples) {
                    $temperatures += [double]$sample.main.temp_min
                    $temperatures += [double]$sample.main.temp_max
                    $localHour = [DateTimeOffset]::FromUnixTimeSeconds([long]$sample.dt).ToOffset([TimeSpan]::FromSeconds($offsetSeconds)).Hour
                    $noonDistance = [Math]::Abs($localHour - 12)
                    if ($noonDistance -lt $nearestNoonDistance) { $noonSample = $sample; $nearestNoonDistance = $noonDistance }
                    if ([double]$sample.pop -gt $rainChance) { $rainChance = [double]$sample.pop }
                }
                $forecastSummary = @{
                    date = $date
                    minTemperatureC = [Math]::Round(($temperatures | Measure-Object -Minimum).Minimum)
                    maxTemperatureC = [Math]::Round(($temperatures | Measure-Object -Maximum).Maximum)
                    condition = [string]$noonSample.weather[0].main
                    description = [string]$noonSample.weather[0].description
                    precipitationChancePercent = [Math]::Round($rainChance * 100)
                }
                $forecastStatus = 'available'
            }
        }

        $condition = $current.weather[0]
        $observedAt = [DateTimeOffset]::FromUnixTimeSeconds([long]$current.dt).UtcDateTime.ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)
        $snapshot = @{
            location = (@($place.name, $place.state, $place.country) | Where-Object { $_ }) -join ', '
            current = @{
                temperatureC = [Math]::Round([double]$current.main.temp)
                feelsLikeC = [Math]::Round([double]$current.main.feels_like)
                humidityPercent = [int]$current.main.humidity
                windSpeedKph = [Math]::Round(([double]$current.wind.speed) * 3.6)
                condition = [string]$condition.main
                description = [string]$condition.description
                observedAt = $observedAt
            }
            forecast = $forecastSummary
            forecastStatus = $forecastStatus
            source = 'OpenWeather'
        }
        return [pscustomobject]@{ Status = 200; Body = $snapshot }
    } catch {
        $upstreamStatus = 0
        if ($_.Exception.Response) { try { $upstreamStatus = [int]$_.Exception.Response.StatusCode } catch { $upstreamStatus = 0 } }
        if ($upstreamStatus -eq 401) {
            return [pscustomobject]@{ Status = 502; Body = @{ code = 'invalid_api_key'; message = 'OpenWeather rejected the key. Check it in your account; newly created keys can take up to two hours to activate.' } }
        }
        return [pscustomobject]@{ Status = 502; Body = @{ code = 'provider_unavailable'; message = 'Weather is temporarily unavailable. Check your OpenWeather key and try again.' } }
    }
}

function Get-NearbyData([string]$destination, [int]$radiusMeters = 18000) {
    $encoded = [uri]::EscapeDataString($destination)
    $geo = Invoke-RestMethod -Uri "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=$encoded" -Headers @{ 'User-Agent' = 'DaytripPlanner/1.0 (local demo)' } -TimeoutSec 12 -ErrorAction Stop
    if (-not $geo -or -not $geo[0]) { return $null }
    $center = @{ lat = [double]$geo[0].lat; lon = [double]$geo[0].lon; displayName = [string]$geo[0].display_name }
    $radius = [Math]::Max(1000, [Math]::Min(100000, $radiusMeters))
    $q = "[out:json][timeout:15];(node(around:$radius,$($center.lat),$($center.lon))[name][tourism~`"attraction|museum|viewpoint|zoo|theme_park`"];way(around:$radius,$($center.lat),$($center.lon))[name][tourism~`"attraction|museum|viewpoint|zoo|theme_park`"] ;node(around:$radius,$($center.lat),$($center.lon))[name][historic];way(around:$radius,$($center.lat),$($center.lon))[name][historic];node(around:$radius,$($center.lat),$($center.lon))[name][leisure=park];way(around:$radius,$($center.lat),$($center.lon))[name][leisure=park];node(around:$radius,$($center.lat),$($center.lon))[name][amenity~`"cafe|restaurant`"];) ;out center tags 60;"
    $form = @{ data = $q }
    try { $data = Invoke-RestMethod -Uri 'https://overpass-api.de/api/interpreter' -Method Post -ContentType 'application/x-www-form-urlencoded' -Body $form -Headers @{ 'User-Agent' = 'DaytripPlanner/1.0 (local demo)' } -TimeoutSec 8 -ErrorAction Stop }
    catch {
        $fallbackPlaces=@();$fallbackSeen=@{};$searches=@('park','museum')
        for($searchIndex=0;$searchIndex -lt $searches.Count;$searchIndex++){
            if($searchIndex -gt 0){Start-Sleep -Milliseconds 1100}
            $query=[uri]::EscapeDataString("$($searches[$searchIndex]) in $destination")
            try {
                $results=Invoke-RestMethod -Uri "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&addressdetails=0&q=$query" -Headers @{ 'User-Agent'='DaytripPlanner/1.0 (local demo)';'Accept-Language'='en' } -TimeoutSec 4 -ErrorAction Stop
                foreach($item in @($results)){
                    $name=[string]$item.name;if(-not $name){$name=[string]$item.display_name.Split(',')[0]}
                    if(-not $name -or $fallbackSeen.ContainsKey($name.ToLowerInvariant()) -or $null -eq $item.lat -or $null -eq $item.lon){continue}
                    $lat=[double]$item.lat;$lon=[double]$item.lon
                    $dLat=($lat-[double]$center.lat)*[Math]::PI/180;$dLon=($lon-[double]$center.lon)*[Math]::PI/180;$a=[Math]::Sin($dLat/2)*[Math]::Sin($dLat/2)+[Math]::Cos([double]$center.lat*[Math]::PI/180)*[Math]::Cos($lat*[Math]::PI/180)*[Math]::Sin($dLon/2)*[Math]::Sin($dLon/2);$distance=6371*2*[Math]::Atan2([Math]::Sqrt($a),[Math]::Sqrt([Math]::Max(0,1-$a)))
                    if($distance -gt ($radius/1000)){continue}
                    $fallbackSeen[$name.ToLowerInvariant()]=$true;$category='Nature';if($searches[$searchIndex] -eq 'museum'){$category='Museum'}
                    $fallbackPlaces+=@{name=$name;category=$category;lat=$lat;lon=$lon;source='OpenStreetMap'}
                }
            } catch { }
        }
        return @{ center=$center; places=@($fallbackPlaces); placesStatus=$(if($fallbackPlaces.Count){'available'}else{'unavailable'}); source='OpenStreetMap' }
    }
    $seen = @{}
    $places = @()
    foreach ($item in @($data.elements)) {
        $tags = $item.tags
        $point = $item.center
        if (-not $point) { $point = $item }
        $name = [string]$tags.name
        if ([string]::IsNullOrWhiteSpace($name) -or $seen.ContainsKey($name.ToLowerInvariant())) { continue }
        $seen[$name.ToLowerInvariant()] = $true
        $category = 'Attraction'
        if ($tags.amenity) { $category = 'Food & rest' } elseif ($tags.leisure -eq 'park' -or $tags.natural) { $category = 'Nature' } elseif ($tags.historic) { $category = 'History & culture' } elseif ($tags.tourism -eq 'museum') { $category = 'Museum' } elseif ($tags.tourism -eq 'viewpoint') { $category = 'Viewpoint' }
        if ($null -ne $point.lat -and $null -ne $point.lon) { $places += @{ name=$name; category=$category; lat=[double]$point.lat; lon=[double]$point.lon; source='OpenStreetMap' } }
    }
    return @{ center=$center; places=@($places | Select-Object -First 60); placesStatus='available'; source='OpenStreetMap' }
}

function Read-JsonBody($request) {
    $reader = [System.IO.StreamReader]::new($request.InputStream, $request.ContentEncoding)
    try { return ConvertFrom-Json -InputObject $reader.ReadToEnd() -ErrorAction Stop } finally { $reader.Dispose() }
}

function Get-PlacesResponse($request) {
    if ($request.HttpMethod -ne 'GET') { return @{ Status=405; Body=@{code='method_not_allowed';message='Use GET for place lookup.'} } }
    $destination=([string]$request.QueryString['destination']).Trim()
    if (-not $destination) { return @{Status=400;Body=@{code='destination_required';message='Enter a destination or starting location.'}} }
    try {
        $radius=18000; if ($request.QueryString['radius']) { $radius=[int]$request.QueryString['radius']*1 }
        $data=Get-NearbyData $destination $radius
        if (-not $data) { return @{Status=404;Body=@{code='location_not_found';message='OpenStreetMap could not find that location.'}} }
        return @{Status=200;Body=$data}
    } catch { return @{Status=502;Body=@{code='places_unavailable';message='OpenStreetMap place lookup is temporarily unavailable.'}} }
}

function Post-RouteResponse($request) {
    if ($request.HttpMethod -ne 'POST') { return @{Status=405;Body=@{code='method_not_allowed';message='Use POST for route lookup.'}} }
    try { $inputData=Read-JsonBody $request } catch { return @{Status=400;Body=@{code='invalid_json';message='Route request was not valid JSON.'}} }
    $points=@($inputData.points)
    if ($inputData.profile -and $inputData.profile -ne 'driving') { return @{Status=422;Body=@{code='profile_unavailable';message='Verified routes are currently available for driving only.'}} }
    if ($points.Count -lt 2 -or $points.Count -gt 10) { return @{Status=400;Body=@{code='invalid_points';message='Route lookup needs 2–10 verified coordinates.'}} }
    try {
        $coords=(@($points | ForEach-Object { "$($_.lon),$($_.lat)" }) -join ';')
        $route=Invoke-RestMethod -Uri "https://router.project-osrm.org/route/v1/driving/$coords`?overview=full&geometries=geojson&steps=false" -TimeoutSec 15 -ErrorAction Stop
        $leg=$route.routes[0]
        if ($route.code -ne 'Ok' -or -not $leg.geometry.coordinates) { throw 'Route unavailable.' }
        return @{Status=200;Body=@{distanceKm=[double]$leg.distance/1000;durationMinutes=[double]$leg.duration/60;geometry=$leg.geometry;source='OSRM';verified=$true}}
    } catch { return @{Status=502;Body=@{code='route_unavailable';message='No verified driving route was returned.'}} }
}

function Post-ItineraryResponse($request) {
    if ($request.HttpMethod -ne 'POST') { return @{Status=405;Body=@{code='method_not_allowed';message='Use POST to generate an itinerary.'}} }
    try { $requestBody=Read-JsonBody $request; $p=$requestBody; if ($requestBody.preferences) { $p=$requestBody.preferences } } catch { return @{Status=400;Body=@{code='invalid_json';message='Trip request was not valid JSON.'}} }
    $total=[int]$p.adults+[int]$p.children
    if (-not $p.start -or $total -lt 1 -or $total -gt 30 -or -not $p.interests -or -not $p.transport -or [double]$p.budget -le 0) { return @{Status=400;Body=@{code='invalid_preferences';message='Please complete the required trip details.'}} }
    $destination=[string]$p.destination
    $lookup=$destination
    if (-not $lookup) { $lookup=[string]$p.start }
    $radius=18000; if (-not $destination -and $p.maxDistance) { $radius=[Math]::Min(100000,[int]$p.maxDistance*1000) }
    try { $places=Get-NearbyData $lookup $radius } catch { $places=$null }
    if (-not $places -or -not $places.places.Count) { return @{Status=503;Body=@{code='no_verified_places';message='No named places could be verified nearby. Add a destination or try again.'}} }
    $sources=@()
    if ($tavilyApiKey) {
        try {
            $research=Invoke-RestMethod -Uri 'https://api.tavily.com/search' -Method Post -Headers @{Authorization="Bearer $tavilyApiKey"} -ContentType 'application/json' -Body (@{query="Day trip guide $lookup; $($p.interests -join ', ')";search_depth='basic';max_results=5;include_answer=$false}|ConvertTo-Json -Compress) -TimeoutSec 10 -ErrorAction Stop
            $sources=@($research.results | Where-Object { $_.url -match '^https?://' } | Select-Object -First 5 | ForEach-Object { @{title=[string]$_.title;url=[string]$_.url} })
        } catch { $sources=@() }
    }
    $candidates=@($places.places | Select-Object -First 35 | ForEach-Object { @{name=$_.name;category=$_.category;lat=$_.lat;lon=$_.lon} })
    $previous=$requestBody.previousItinerary
    if (-not $previous -and $destination) { $previous=Get-AutoArchivedPlan $destination }
    $previousContext=$null
    if ($previous -and $destination -and [string]::Equals([string]$previous.destination,$destination,[System.StringComparison]::OrdinalIgnoreCase) -and $previous.stops) { $previousContext=@{note='Optional starting point only; current preferences, verified places, schedule, and budget take priority.';stops=@($previous.stops | Select-Object -First 12 | ForEach-Object {@{name=([string]$_.name).Substring(0,[Math]::Min(120,([string]$_.name).Length));category=([string]$_.category).Substring(0,[Math]::Min(60,([string]$_.category).Length));description=([string]$_.description).Substring(0,[Math]::Min(240,([string]$_.description).Length))}})} }
    $demoPlaces=@($places.places)
    if ($previousContext -and $previousContext.stops.Count) { $reusedPlaces=@(); foreach($oldStop in $previousContext.stops){$match=$places.places | Where-Object { [string]::Equals([string]$_.name,[string]$oldStop.name,[System.StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1;if($match){$reusedPlaces+=,$match}};if($reusedPlaces.Count){$demoPlaces=@($reusedPlaces)} }
    $payload=@{preferences=$p;verifiedOpenStreetMapPlaceCandidates=$candidates;researchSources=$sources;previousItinerary=$previousContext}
    $system='Return valid JSON only with title, destination, stops, budget, tips. Stop fields: name, category, arrival (HH:mm), departure (HH:mm), description, match, duration (minutes), entryCostPerPerson, activityCostPerPerson. Budget fields transportation, food, tickets, activities, parking, miscellaneous are INR estimates per person. Select exact stop names only from verifiedOpenStreetMapPlaceCandidates. Never invent coordinates, opening hours, or verified prices. Keep times sequential between depart and return. If destination is blank, choose a nearby candidate. Respect interests, dietary needs, avoid/must-visit fields, accessibility, max distance, and budget. Use previousItinerary only as optional inspiration; current preferences and verified place data always take priority.'
    if ($groqApiKey) {
        try {
            $model='openai/gpt-oss-20b'; if ($env:GROQ_MODEL) { $model=$env:GROQ_MODEL }
            $requestBody=@{model=$model;temperature=0.3;response_format=@{type='json_object'};messages=@(@{role='system';content=$system},@{role='user';content=($payload|ConvertTo-Json -Depth 8 -Compress)})}|ConvertTo-Json -Depth 10 -Compress
            $response=Invoke-RestMethod -Uri 'https://api.groq.com/openai/v1/chat/completions' -Method Post -Headers @{Authorization="Bearer $groqApiKey"} -ContentType 'application/json' -Body $requestBody -TimeoutSec 28 -ErrorAction Stop
            $generated=$response.choices[0].message.content | ConvertFrom-Json -ErrorAction Stop
            if (-not $generated.stops -or -not $generated.budget) { throw 'Incomplete plan.' }
        } catch { return @{Status=502;Body=@{code='planning_unavailable';message='AI could not create a valid plan. Please retry or use a destination-specific demo.'}} }
    } else {
        $departTime=[timespan]::ParseExact([string]$p.depart,'hh\:mm',$null);$returnTime=[timespan]::ParseExact([string]$p.return,'hh\:mm',$null)
        $window=($returnTime-$departTime).TotalMinutes;$count=[Math]::Min($(if($p.pace -eq 'Relaxed'){2}else{3}),$demoPlaces.Count);$block=[Math]::Max(45,[Math]::Floor(($window-30-[Math]::Max(0,$count-1)*25)/[Math]::Max(1,$count)));$cursor=$departTime.TotalMinutes+15
        $demoStops=@();for($i=0;$i -lt $count;$i++){if($i -gt 0){$cursor+=25};$place=$demoPlaces[$i];$arrival=[timespan]::FromMinutes($cursor).ToString('hh\:mm');$cursor+=$block;$leave=[timespan]::FromMinutes($cursor).ToString('hh\:mm');$demoStops+=@{name=$place.name;category=$place.category;arrival=$arrival;departure=$leave;duration=[int]$block;description="Mapped $($place.category.ToLowerInvariant()) near $lookup. Confirm access and opening hours before visiting.";match="A nearby mapped option for $($p.interests -join ', ').";entryCostPerPerson=$null;activityCostPerPerson=$null}}
        $destinationName=$destination;if(-not $destinationName -and $demoStops.Count){$destinationName=[string]$demoStops[0].name}
        $generated=@{title="A day near $destinationName";destination=$destinationName;stops=$demoStops;budget=@{transportation=225;food=$(if($p.restaurantRecommendations){225}else{50});tickets=0;activities=0;parking=50;miscellaneous=75};tips=@('Confirm access, opening hours, and prices directly with venues.','Travel times and costs are estimates, not provider quotes.','Check the weather close to departure before outdoor plans.')}
    }
    $byName=@{}; foreach($place in $places.places){$byName[$place.name.ToLowerInvariant()]=$place}
    $stops=@(); foreach($stop in $generated.stops){$stopName=([string]$stop.name).ToLowerInvariant();$place=$byName[$stopName];if(-not $place){continue};$priceStatus='estimated';if(-not $groqApiKey){$priceStatus='unavailable'};$entry=$null;$activity=$null;if($null -ne $stop.entryCostPerPerson){$entry=[double]$stop.entryCostPerPerson};if($null -ne $stop.activityCostPerPerson){$activity=[double]$stop.activityCostPerPerson};$stops+=@{id=[guid]::NewGuid().ToString();name=$place.name;category=$place.category;arrival=[string]$stop.arrival;departure=[string]$stop.departure;description=[string]$stop.description;match=[string]$stop.match;duration=[int]$stop.duration;distanceFromPreviousKm=$null;travelMinutes=$null;entryCostPerPerson=$entry;activityCostPerPerson=$activity;priceStatus=$priceStatus;lat=$place.lat;lon=$place.lon;coordinatesVerified=$true;routeVerified=$false}}
    if (-not $stops.Count) { return @{Status=502;Body=@{code='planning_unavailable';message='AI results did not match verified OpenStreetMap places.'}} }
    $returnMinutes=([timespan]::ParseExact([string]$p.return,'hh\:mm',$null)).TotalMinutes
    $cursor=([timespan]::ParseExact([string]$p.depart,'hh\:mm',$null)).TotalMinutes
    foreach($stop in $stops){$arrival=([timespan]::ParseExact($stop.arrival,'hh\:mm',$null)).TotalMinutes;$departure=([timespan]::ParseExact($stop.departure,'hh\:mm',$null)).TotalMinutes;if($arrival -lt $cursor -or $departure -le $arrival -or $departure -gt $returnMinutes){return @{Status=422;Body=@{code='infeasible_schedule';message='The generated times do not fit the available trip day. Try regenerating.'}}};$cursor=$departure}
    $routeDistance=$null;$routeGeometry=@();$routeVerified=$false
    if (@($p.transport | Where-Object { $_ -in @('Personal car','Taxi or cab') }).Count -gt 0) {
        $routePoints=@(@{lat=$places.center.lat;lon=$places.center.lon})+@($stops | ForEach-Object {@{lat=$_.lat;lon=$_.lon}})+@(@{lat=$places.center.lat;lon=$places.center.lon})
        try {
            $routeCoords=(@($routePoints | ForEach-Object { "$($_.lon),$($_.lat)" }) -join ';')
            $road=Invoke-RestMethod -Uri "https://router.project-osrm.org/route/v1/driving/$routeCoords`?overview=full&geometries=geojson&steps=false" -TimeoutSec 15 -ErrorAction Stop
            if($road.code -eq 'Ok' -and $road.routes[0].legs.Count -ge ($stops.Count+1)){
                $legs=@($road.routes[0].legs);$earliest=([timespan]::ParseExact([string]$p.depart,'hh\:mm',$null)).TotalMinutes;$fits=$true
                for($i=0;$i -lt $stops.Count;$i++){$earliest += [double]$legs[$i].duration/60;$arrival=([timespan]::ParseExact($stops[$i].arrival,'hh\:mm',$null)).TotalMinutes;if($arrival -lt $earliest){$fits=$false};$earliest=([timespan]::ParseExact($stops[$i].departure,'hh\:mm',$null)).TotalMinutes}
                $earliest += [double]$legs[$stops.Count].duration/60;if($earliest -gt $returnMinutes){$fits=$false}
                if(-not $fits){return @{Status=422;Body=@{code='infeasible_schedule';message='The schedule does not fit the verified driving times. Regenerate or allow more time.'}}}
                $routeDistance=[double]$road.routes[0].distance/1000;$routeGeometry=@($road.routes[0].geometry.coordinates | ForEach-Object {@([double]$_[1],[double]$_[0])});$routeVerified=$true
                for($i=0;$i -lt $stops.Count;$i++){$stops[$i].distanceFromPreviousKm=[double]$legs[$i].distance/1000;$stops[$i].travelMinutes=[double]$legs[$i].duration/60;$stops[$i].routeVerified=$true}
            }
        } catch { $routeDistance=$null;$routeGeometry=@();$routeVerified=$false }
    }
    $budget=@{}; foreach($key in @('transportation','food','tickets','activities','parking','miscellaneous')){$amount=[double]$generated.budget.$key;$budget[$key]=[Math]::Round($amount*[int]$p.adults+$amount*[int]$p.children*0.65)}
    $groupTotal=0;foreach($value in $budget.Values){$groupTotal += [double]$value};$perPerson=[Math]::Ceiling($groupTotal/[Math]::Max(1,$total));$basis=[string]$p.budgetBasis;if($basis -notin @('group','person')){$basis='group'};$budgetLimit=[double]$p.budget;if($basis -eq 'person'){$budgetLimit=$budgetLimit*$total}
    $recommendations=@();if(-not $destination){$recommendations=@($stops | Select-Object -First 3 | ForEach-Object {@{name=$_.name;reason='A nearby mapped place selected for your interests.';coordinatesVerified=$true;lat=$_.lat;lon=$_.lon;sources=$sources}});$destination=[string]$stops[0].name}
    $source='ai';if(-not $groqApiKey){$source='demo'}
    $body=@{id=[guid]::NewGuid().ToString();title=[string]$generated.title;destination=$destination;start=[string]$p.start;date=[string]$p.date;travelers=$total;adults=[int]$p.adults;children=[int]$p.children;currency='INR';budgetBasis=$basis;budgetLimit=$budgetLimit;remainingBudget=$budgetLimit-$groupTotal;totalDistanceKm=$routeDistance;routeVerified=$routeVerified;routeGeometry=$routeGeometry;totalDurationHours=([datetime]::ParseExact($p.return,'HH:mm',$null)-[datetime]::ParseExact($p.depart,'HH:mm',$null)).TotalHours;totalPerPerson=$perPerson;totalGroup=$groupTotal;remainingBudgetPerPerson=[Math]::Floor(($budgetLimit-$groupTotal)/[Math]::Max(1,$total));stops=$stops;budget=$budget;recommendations=$recommendations;researchSources=$sources;tips=@($generated.tips);source=$source;generatedAt=[DateTime]::UtcNow.ToString('o');archivePersisted=$true}
    Save-AutoGeneratedPlan $p $body
    return @{Status=200;Body=$body}
}

if (-not (Test-Path -LiteralPath $indexPath -PathType Leaf)) {
    throw "Built app not found at '$indexPath'. The dist folder must be present."
}

function Read-TcpRequest($stream, [int]$serverPort) {
    $headerBytes = [System.Collections.Generic.List[byte]]::new()
    $matched = 0
    $marker = @(13,10,13,10)
    while ($headerBytes.Count -lt 32768) {
        $next = $stream.ReadByte()
        if ($next -lt 0) { throw 'Client closed before sending HTTP headers.' }
        $headerBytes.Add([byte]$next)
        if ($next -eq $marker[$matched]) { $matched++ } else { $matched = if ($next -eq 13) { 1 } else { 0 } }
        if ($matched -eq 4) { break }
    }
    if ($matched -ne 4) { throw 'HTTP headers were too large or incomplete.' }
    $headerText = [System.Text.Encoding]::ASCII.GetString($headerBytes.ToArray())
    $lines = $headerText -split "`r`n"
    $requestLine = $lines[0] -split ' ',3
    if ($requestLine.Count -lt 2 -or $requestLine[2] -notmatch '^HTTP/1\.[01]$') { throw 'Malformed HTTP request line.' }
    $headers = @{}
    foreach ($line in $lines | Select-Object -Skip 1) {
        if (-not $line) { continue }
        $separator = $line.IndexOf(':')
        if ($separator -gt 0) { $headers[$line.Substring(0,$separator).Trim()] = $line.Substring($separator+1).Trim() }
    }
    $hostHeader = [string]$headers['Host']
    if ($hostHeader -notmatch '^(localhost|127\.0\.0\.1)(:\d+)?$') { throw 'Only loopback Host headers are accepted.' }
    $url = [uri]::new("http://$hostHeader$($requestLine[1])")
    $contentLength = 0
    if ($headers['Content-Length']) { $contentLength = [int]$headers['Content-Length'] }
    if ($contentLength -lt 0 -or $contentLength -gt 1048576) { throw 'Request body exceeded the local server limit.' }
    $bodyBytes = [byte[]]::new($contentLength)
    $read = 0
    while ($read -lt $contentLength) {
        $count = $stream.Read($bodyBytes,$read,$contentLength-$read)
        if ($count -le 0) { throw 'Client closed before sending the full request body.' }
        $read += $count
    }
    $query = [System.Collections.Specialized.NameValueCollection]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($pair in $url.Query.TrimStart('?') -split '&') {
        if (-not $pair) { continue }
        $parts = $pair -split '=',2
        $name = [uri]::UnescapeDataString($parts[0].Replace('+',' '))
        $value = ''; if ($parts.Count -gt 1) { $value = [uri]::UnescapeDataString($parts[1].Replace('+',' ')) }
        $query.Add($name,$value)
    }
    $encoding = [System.Text.Encoding]::UTF8
    if ($headers['Content-Type'] -match 'charset=([^; ]+)') { try { $encoding=[System.Text.Encoding]::GetEncoding($Matches[1]) } catch { } }
    return [pscustomobject]@{HttpMethod=$requestLine[0].ToUpperInvariant();Url=$url;QueryString=$query;Headers=$headers;InputStream=[System.IO.MemoryStream]::new($bodyBytes);ContentEncoding=$encoding}
}

$listener = $null
foreach ($candidatePort in 5173..5190) {
    $candidateListener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,$candidatePort)
    try { $candidateListener.Start(); $listener = $candidateListener; $port = $candidatePort; break }
    catch { $candidateListener.Stop() }
}
if (-not $listener) { throw 'Could not start Daytrip. Ports 5173 through 5190 are unavailable.' }

Write-Host "Daytrip is running at http://127.0.0.1:$port" -ForegroundColor Green
Write-Host 'Press Ctrl+C in this window to stop it.' -ForegroundColor Gray
Start-Process "http://127.0.0.1:$port"

$mimeTypes = @{
    '.html' = 'text/html; charset=utf-8'
    '.js' = 'text/javascript; charset=utf-8'
    '.mjs' = 'text/javascript; charset=utf-8'
    '.css' = 'text/css; charset=utf-8'
    '.json' = 'application/json; charset=utf-8'
    '.svg' = 'image/svg+xml'
    '.png' = 'image/png'
    '.jpg' = 'image/jpeg'
    '.jpeg' = 'image/jpeg'
    '.webp' = 'image/webp'
    '.ico' = 'image/x-icon'
    '.woff' = 'font/woff'
    '.woff2' = 'font/woff2'
}
$rootPrefix = $distRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$autoArchivePath = Join-Path $PSScriptRoot 'daytrip-data/itinerary-archive.json'
$archiveDirectory = Split-Path -Parent $autoArchivePath
if (-not (Test-Path -LiteralPath $archiveDirectory -PathType Container)) { New-Item -ItemType Directory -Path $archiveDirectory -Force | Out-Null }
if (-not (Test-Path -LiteralPath $autoArchivePath -PathType Leaf)) { [System.IO.File]::WriteAllText($autoArchivePath,'[]',[System.Text.UTF8Encoding]::new($false)) }

function Get-AutoArchivedPlan([string]$destination) {
    if (-not $destination -or -not (Test-Path -LiteralPath $autoArchivePath -PathType Leaf)) { return $null }
    try {
        $entries=@([System.IO.File]::ReadAllText($autoArchivePath) | ConvertFrom-Json)
        $city=$destination.Trim()
        $entry=$entries | Where-Object { $_.itinerary.destination -and ([string]::Equals(([string]$_.itinerary.destination).Trim(),$city,[System.StringComparison]::OrdinalIgnoreCase) -or ([string]$_.itinerary.destination).StartsWith($city,[System.StringComparison]::OrdinalIgnoreCase)) } | Select-Object -First 1
        if ($entry) { return $entry.itinerary }
    } catch { return $null }
    return $null
}

function Save-AutoGeneratedPlan($preferences,$itinerary) {
    try {
        $directory=Split-Path -Parent $autoArchivePath
        if (-not (Test-Path -LiteralPath $directory -PathType Container)) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
        $entries=@()
        if (Test-Path -LiteralPath $autoArchivePath -PathType Leaf) { try { $entries=@([System.IO.File]::ReadAllText($autoArchivePath) | ConvertFrom-Json) } catch { $entries=@() } }
        $entry=[pscustomobject]@{id=[string]$itinerary.id;savedAt=[DateTime]::UtcNow.ToString('o');preferences=$preferences;itinerary=$itinerary}
        $entries=@($entry)+@($entries | Where-Object { [string]$_.id -ne [string]$entry.id })
        $entries=@($entries | Select-Object -First 40)
        $json=ConvertTo-Json -InputObject $entries -Depth 25
        [System.IO.File]::WriteAllText($autoArchivePath,$json,[System.Text.UTF8Encoding]::new($false))
    } catch { }
}

try {
    while ($true) {
        $client = $null
        $network = $null
        $responseBody = $null
        try {
            $client = $listener.AcceptTcpClient()
            $client.ReceiveTimeout = 15000
            $network = $client.GetStream()
            $request = Read-TcpRequest $network $port
            $responseBody = [System.IO.MemoryStream]::new()
            $response = [pscustomobject]@{StatusCode=200;ContentType='application/octet-stream';ContentLength64=0L;Headers=@{};OutputStream=$responseBody}
            $response.Headers['X-Content-Type-Options'] = 'nosniff'
            $response.Headers['Cache-Control'] = 'no-cache'

            if ($request.Url.AbsolutePath -eq '/api/audit/history' -or $request.Url.AbsolutePath -eq '/api/audit/run') {
                $result = Get-AuditResponse $request $PSScriptRoot $groqApiKey $auditCriticModel
                $auditBody = ConvertTo-Json -InputObject $result.Body -Depth 24 -Compress
                $body = [System.Text.Encoding]::UTF8.GetBytes($auditBody)
                $response.StatusCode = $result.Status
                $response.ContentType = 'application/json; charset=utf-8'
                $response.Headers['Cache-Control'] = 'no-store'
                $response.Headers['X-Frame-Options'] = 'DENY'
                $response.ContentLength64 = $body.Length
                if ($request.HttpMethod -ne 'HEAD') { $response.OutputStream.Write($body, 0, $body.Length) }
            } elseif ($request.Url.AbsolutePath -eq '/api/weather') {
                $result = Get-WeatherResponse $request
                $body = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $result.Body -Depth 8 -Compress))
                $response.StatusCode = $result.Status
                $response.ContentType = 'application/json; charset=utf-8'
                $response.ContentLength64 = $body.Length
                if ($request.HttpMethod -ne 'HEAD') { $response.OutputStream.Write($body, 0, $body.Length) }
            } elseif ($request.Url.AbsolutePath -eq '/api/places') {
                $result = Get-PlacesResponse $request
                $body = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $result.Body -Depth 8 -Compress))
                $response.StatusCode = $result.Status
                $response.ContentType = 'application/json; charset=utf-8'
                $response.ContentLength64 = $body.Length
                if ($request.HttpMethod -ne 'HEAD') { $response.OutputStream.Write($body, 0, $body.Length) }
            } elseif ($request.Url.AbsolutePath -eq '/api/route') {
                $result = Post-RouteResponse $request
                $body = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $result.Body -Depth 8 -Compress))
                $response.StatusCode = $result.Status
                $response.ContentType = 'application/json; charset=utf-8'
                $response.ContentLength64 = $body.Length
                if ($request.HttpMethod -ne 'HEAD') { $response.OutputStream.Write($body, 0, $body.Length) }
            } elseif ($request.Url.AbsolutePath -eq '/api/itinerary') {
                $result = Post-ItineraryResponse $request
                $body = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $result.Body -Depth 8 -Compress))
                $response.StatusCode = $result.Status
                $response.ContentType = 'application/json; charset=utf-8'
                $response.ContentLength64 = $body.Length
                if ($request.HttpMethod -ne 'HEAD') { $response.OutputStream.Write($body, 0, $body.Length) }
            } elseif ($request.Url.AbsolutePath.StartsWith('/api/')) {
                $body = [System.Text.Encoding]::UTF8.GetBytes('{"code":"not_found","message":"Unknown API endpoint."}')
                $response.StatusCode = 404
                $response.ContentType = 'application/json; charset=utf-8'
                $response.ContentLength64 = $body.Length
                if ($request.HttpMethod -ne 'HEAD') { $response.OutputStream.Write($body, 0, $body.Length) }
            } elseif ($request.HttpMethod -notin @('GET', 'HEAD')) {
                $response.StatusCode = 405
                $response.Headers['Allow'] = 'GET, HEAD'
            } else {
                $relativePath = [Uri]::UnescapeDataString($request.Url.AbsolutePath).TrimStart('/')
                if ([string]::IsNullOrWhiteSpace($relativePath)) { $relativePath = 'index.html' }
                $candidate = [System.IO.Path]::GetFullPath((Join-Path $distRoot $relativePath))
                if (-not $candidate.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
                    $response.StatusCode = 403
                } elseif (Test-Path -LiteralPath $candidate -PathType Leaf) {
                    $extension = [System.IO.Path]::GetExtension($candidate).ToLowerInvariant()
                    if ($mimeTypes.ContainsKey($extension)) { $response.ContentType = $mimeTypes[$extension] }
                    $bytes = [System.IO.File]::ReadAllBytes($candidate)
                    $response.StatusCode = 200
                    $response.ContentLength64 = $bytes.Length
                    if ($request.HttpMethod -ne 'HEAD') { $response.OutputStream.Write($bytes, 0, $bytes.Length) }
                } else {
                    $response.StatusCode = 404
                }
            }
        } catch {
            if ($response) { $response.StatusCode = 500; $responseBody.SetLength(0) }
        } finally {
            if ($client -and $network -and $responseBody) {
                try {
                    $bytes = $responseBody.ToArray()
                    $reason = switch ([int]$response.StatusCode) { 200 {'OK'} 400 {'Bad Request'} 403 {'Forbidden'} 404 {'Not Found'} 405 {'Method Not Allowed'} 409 {'Conflict'} 413 {'Payload Too Large'} 422 {'Unprocessable Entity'} 500 {'Internal Server Error'} 502 {'Bad Gateway'} 503 {'Service Unavailable'} default {'Response'} }
                    $headersOut = @("HTTP/1.1 $($response.StatusCode) $reason",'Connection: close',"Content-Length: $($bytes.Length)")
                    if ($response.ContentType) { $headersOut += "Content-Type: $($response.ContentType)" }
                    foreach ($key in $response.Headers.Keys) { $headersOut += "$key`: $($response.Headers[$key])" }
                    $headersOut += "`r`n"
                    $headerBytes = [System.Text.Encoding]::ASCII.GetBytes(($headersOut -join "`r`n"))
                    $network.Write($headerBytes,0,$headerBytes.Length)
                    if ($request.HttpMethod -ne 'HEAD' -and $bytes.Length -gt 0) { $network.Write($bytes,0,$bytes.Length) }
                    $network.Flush()
                } catch { }
            }
            if ($responseBody) { $responseBody.Dispose() }
            if ($network) { $network.Dispose() }
            if ($client) { $client.Close() }
        }
    }
} finally {
    $listener.Stop()
}
