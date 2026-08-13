"""
Voice AI -- diagnóstico pontual (não faz parte do produto): mede a duração
do áudio em CADA estágio do pipeline TTS real (Piper nativo -> resample
8kHz -> ulaw), pra achar em qual etapa uma eventual distorção de
sample rate/duração aconteceria. Usa a MESMA API que tts_worker.py usa.
"""
import audioop
import time
import wave

from piper import PiperVoice
from piper.config import SynthesisConfig

MODELO = r"C:\Users\msi\Projeto Claude Code\voice-models\pt_BR-faber-medium.onnx"
FRASE = "Claro. Vou encaminhar seu atendimento para uma pessoa da nossa equipe."
TELEFONIA_SAMPLE_RATE = 8000


def resample_para_telefonia(wav_path):
    with wave.open(wav_path, "rb") as wav_in:
        n_channels = wav_in.getnchannels()
        sample_width = wav_in.getsampwidth()
        sample_rate = wav_in.getframerate()
        frames = wav_in.readframes(wav_in.getnframes())

    if n_channels > 1:
        frames = audioop.tomono(frames, sample_width, 0.5, 0.5)
    if sample_rate != TELEFONIA_SAMPLE_RATE:
        frames, _ = audioop.ratecv(frames, sample_width, 1, sample_rate, TELEFONIA_SAMPLE_RATE, None)

    with wave.open(wav_path, "wb") as wav_out:
        wav_out.setnchannels(1)
        wav_out.setsampwidth(sample_width)
        wav_out.setframerate(TELEFONIA_SAMPLE_RATE)
        wav_out.writeframes(frames)

    return frames, sample_width


for length_scale in [1.00, 1.10]:
    print(f"\n=== length_scale={length_scale} ===")
    voice = PiperVoice.load(MODELO)
    wav_path = rf"C:\Users\msi\AppData\Local\Temp\_diag_ls{str(length_scale).replace('.', '')}.wav"

    # ESTAGIO A: saida nativa do Piper (antes de qualquer resample)
    with wave.open(wav_path, "wb") as wav_file:
        voice.synthesize_wav(FRASE, wav_file, syn_config=SynthesisConfig(length_scale=length_scale))
    with wave.open(wav_path, "rb") as w:
        sr_a = w.getframerate()
        dur_a = w.getnframes() / w.getframerate() * 1000
    print(f"A) Piper nativo: sample_rate={sr_a} duracao_ms={dur_a:.0f}")

    # ESTAGIO B: apos resample pra telefonia
    frames, sample_width = resample_para_telefonia(wav_path)
    with wave.open(wav_path, "rb") as w:
        sr_b = w.getframerate()
        dur_b = w.getnframes() / w.getframerate() * 1000
    print(f"B) Resampled 8kHz: sample_rate={sr_b} duracao_ms={dur_b:.0f}")

    # ESTAGIO C: ulaw final (sem preroll, so pra medir duracao pura)
    frames_16bit = frames if sample_width == 2 else audioop.lin2lin(frames, sample_width, 2)
    ulaw_bytes = audioop.lin2ulaw(frames_16bit, 2)
    dur_c = len(ulaw_bytes) / TELEFONIA_SAMPLE_RATE * 1000  # 1 byte = 1 amostra em ulaw
    print(f"C) ULAW final: bytes={len(ulaw_bytes)} duracao_ms={dur_c:.0f} (assumindo 8000Hz)")
