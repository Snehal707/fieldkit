# Synthetic speech for the on-device speech-to-text evaluation (tests/eval/stt_eval.mjs): Windows' built-in voices
# (en-US Zira, en-IN Ravi, hi-IN Kalpana and Hemant) read tests/eval/stt_sentences.json into 16 kHz WAV files.
# Synthetic speech is cleaner than a person in the field; the "phone" variant in stt_eval.mjs adds level loss,
# noise and silence. Usage: powershell -File tests/eval/tts.ps1 -Out <dir> -Json tests/eval/stt_sentences.json
param([string]$Out, [string]$Json)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | ? { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, [Type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
[Windows.Media.SpeechSynthesis.SpeechSynthesizer,Windows.Media.SpeechSynthesis,ContentType=WindowsRuntime] | Out-Null
[Windows.Storage.Streams.DataReader,Windows.Storage.Streams,ContentType=WindowsRuntime] | Out-Null
$s = Get-Content -Raw -Encoding UTF8 $Json | ConvertFrom-Json
$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
$voices = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices
$plan = @(@('en','Microsoft Zira'), @('en','Microsoft Ravi'), @('hi','Microsoft Kalpana'), @('hi','Microsoft Hemant'))
foreach ($p in $plan) {
  $synth.Voice = ($voices | ? { $_.DisplayName -eq $p[1] })[0]
  $i = 0
  foreach ($t in $s.($p[0])) {
    $stream = Await ($synth.SynthesizeTextToStreamAsync($t)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
    $reader = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0))
    $n = [uint32]$stream.Size
    Await ($reader.LoadAsync($n)) ([uint32]) | Out-Null
    $bytes = New-Object byte[] $n
    $reader.ReadBytes($bytes)
    $name = "$($p[0])_$($p[1].Split(' ')[1].ToLower())_$i.wav"
    [IO.File]::WriteAllBytes((Join-Path $Out $name), $bytes)
    $i++
  }
}
"done"
