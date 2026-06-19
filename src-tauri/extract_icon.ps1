param (
    [string]$Path
)

try {
    Add-Type -AssemblyName System.Drawing
    if (-not (Test-Path $Path)) {
        Write-Error "File does not exist: $Path"
        exit 1
    }
    
    $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($Path)
    if ($null -eq $icon) {
        Write-Error "Failed to extract icon"
        exit 1
    }
    
    $ms = New-Object System.IO.MemoryStream
    $icon.ToBitmap().Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bytes = $ms.ToArray()
    
    $ms.Close()
    $icon.Dispose()
    
    $base64 = [Convert]::ToBase64String($bytes)
    Write-Output "data:image/png;base64,$base64"
} catch {
    Write-Error $_.Exception.Message
    exit 1
}
