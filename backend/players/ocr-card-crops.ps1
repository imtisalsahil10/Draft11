# Read the prepared name and stat crops with the Windows OCR engine.
param(
    [Parameter(Mandatory = $true)][string]$CropDir,
    [Parameter(Mandatory = $true)][string]$OutFile
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($WinRtTask, $ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
}

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
$writer = [System.IO.StreamWriter]::new($OutFile, $false, [System.Text.UTF8Encoding]::new($false))
try {
    $files = Get-ChildItem -Path $CropDir -Filter *.png | Sort-Object Name
    $done = 0
    foreach ($file in $files) {
        $stream = $null
        $bitmap = $null
        try {
            $storage = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($file.FullName)) ([Windows.Storage.StorageFile])
            $stream = Await ($storage.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
            $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
            $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
            $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
            $lines = @()
            foreach ($line in $result.Lines) {
                $lines += $line.Text
            }
            $payload = @{
                file = $file.Name
                text = ($lines -join ' ')
                lines = $lines
            }
            if ($bitmap) { $bitmap.Dispose() }
            if ($stream) { $stream.Dispose() }
        } catch {
            $payload = @{
                file = $file.Name
                text = ''
                lines = @()
                error = $_.Exception.Message
            }
        }
        $writer.WriteLine(($payload | ConvertTo-Json -Compress))
        $done += 1
        if ($done % 400 -eq 0) {
            $writer.Flush()
            [Console]::Error.WriteLine("ocr $done")
        }
    }
}
finally {
    $writer.Dispose()
}
[Console]::Error.WriteLine("ocr-done $done")
