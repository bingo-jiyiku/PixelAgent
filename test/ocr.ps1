# ============================================================
# ⚠ 未接线（unwired）：这是早期排查"默认模型看不懂图"时写的实验脚本，
#   用 Windows 自带的 OCR 引擎把截图转成文字，再喂给不看图的模型。
#   现状：PixelAgent 已经支持真正的图片输入 + 视觉模型，
#   并且会在模型不看图 / pi 丢图时**明确提示**（见 renderer.js 的 IMG 提示），
#   所以正常路径不需要它。留在这里仅供：
#     · 只有不看图模型可用时的手工兜底
#     · 想自己复核"图上到底写了什么字"的时候
#   用法：powershell -File test/ocr.ps1 -Image <图片> -OutFile <输出>
# ============================================================
param([string]$Image = "E:\PixelAgent\shots\01-idle.png",
      [string]$OutFile = "E:\PixelAgent\test\ocr-out.txt")
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Foundation, ContentType=WindowsRuntime]

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($AsyncOp, $ResultType) {
  $m = $asTaskGeneric.MakeGenericMethod($ResultType)
  $task = $m.Invoke($null, @($AsyncOp))
  $task.Wait(-1) | Out-Null
  $task.Result
}

$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Image)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bmp = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

$lang = New-Object Windows.Globalization.Language("zh-Hans-CN")
if (-not [Windows.Media.Ocr.OcrEngine]::IsLanguageSupported($lang.LanguageTag)) {
  $lang = [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | Select-Object -First 1
}
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
$result = Await ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])

$lines = New-Object System.Collections.Generic.List[string]
foreach ($ln in $result.Lines) {
  $r = $ln.BoundingRect
  $x = [int][Math]::Round($r.X); $y = [int][Math]::Round($r.Y)
  $w = [int][Math]::Round($r.Width); $h = [int][Math]::Round($r.Height)
  $txt = ($ln.Words | ForEach-Object { $_.Text }) -join ''
  $lines.Add("$x,$y,$w,$h`t$txt")
}
[System.IO.File]::WriteAllLines($OutFile, $lines, (New-Object System.Text.UTF8Encoding($false)))
Write-Output ("lang=" + $lang.LanguageTag + " lines=" + $result.Lines.Count)
