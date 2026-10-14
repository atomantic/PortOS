param()
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

# Query structured XML, never the localized message (which includes paths,
# machine identity and report identifiers). No registry changes or dumps.
$filter = @{
    LogName = 'Application'
    ProviderName = 'Application Error'
    Id = 1000
    StartTime = [DateTimeOffset]::Parse($env:PORTOS_CRASH_SINCE).LocalDateTime
    EndTime = [DateTimeOffset]::Parse($env:PORTOS_CRASH_UNTIL).LocalDateTime
}
try {
    $events = @(Get-WinEvent -FilterHashtable $filter -MaxEvents 32 -ErrorAction Stop)
} catch {
    if ($_.FullyQualifiedErrorId -notlike 'NoMatchingEventsFound*') { throw }
    $events = @()
}
$records = @(
    foreach ($event in $events) {
        $fields = @{}
        $xml = [xml]$event.ToXml()
        foreach ($data in $xml.Event.EventData.Data) {
            $fields[[string]$data.Name] = [string]$data.'#text'
        }
        if ($fields.AppName -ieq 'node.exe') {
            # JS validates these values again before publishing any evidence.
            @{
                AppName = $fields.AppName
                AppVersion = $fields.AppVersion
                ModuleName = $fields.ModuleName
                ModuleVersion = $fields.ModuleVersion
                ExceptionCode = $fields.ExceptionCode
                FaultingOffset = $fields.FaultingOffset
            }
        }
    }
)
ConvertTo-Json -InputObject @($records | Select-Object -First 10) -Compress
