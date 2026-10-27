param([Parameter(Mandatory=$true)][string]$RequestPath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
$asyncMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetGenericArguments().Count -eq 1 -and $_.GetParameters().Count -eq 1
} | Select-Object -First 1
function Wait-OcrOperation($operation, [Type]$resultType) {
  $task = $asyncMethod.MakeGenericMethod($resultType).Invoke($null, @($operation))
  $task.GetAwaiter().GetResult()
}
$languages = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages)
$language = $languages | Where-Object { $_.LanguageTag -like 'zh-Hans*' } | Select-Object -First 1
$engine = if ($language) { [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language) } else { $null }
$request = Get-Content -LiteralPath $RequestPath -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($item in $request.images) {
  $stream = $null
  $bitmap = $null
  try {
    if (-not $engine) { throw 'language_unavailable: Chinese OCR language pack is not installed' }
    $file = Wait-OcrOperation ([Windows.Storage.StorageFile]::GetFileFromPathAsync($item.path)) ([Windows.Storage.StorageFile])
    $stream = Wait-OcrOperation ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Wait-OcrOperation ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Wait-OcrOperation ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    if ($bitmap.PixelWidth -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension -or $bitmap.PixelHeight -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension) {
      throw 'image_too_large: OCR image dimensions exceed engine limit'
    }
    $recognized = Wait-OcrOperation ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $regions = @()
    foreach ($line in $recognized.Lines) {
      foreach ($word in $line.Words) {
        $box = $word.BoundingRect
        $regions += @{ text=$word.Text; x=$box.X; y=$box.Y; width=$box.Width; height=$box.Height }
      }
    }
    $result = @{ part=$item.part; status='covered'; text=$recognized.Text; regions=$regions; angle=$recognized.TextAngle; language=$language.LanguageTag }
  } catch {
    $result = @{ part=$item.part; status='unknown'; text=''; regions=@(); reason=$_.Exception.Message }
  } finally {
    if ($bitmap) { $bitmap.Dispose() }
    if ($stream) { $stream.Dispose() }
  }
  [Console]::WriteLine(($result | ConvertTo-Json -Depth 8 -Compress))
}
