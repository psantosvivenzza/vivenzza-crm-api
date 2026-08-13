"""
Voice AI -- benchmark LOCAL de velocidade/inteligibilidade do Piper
(pt_BR-faber-medium), pra comparar por ouvido antes de mudar qualquer
config principal. NÃO toca em tts_worker.py/tts_synthesize.py -- gera as
amostras direto via PiperVoice.synthesize_wav(SynthesisConfig(length_scale=X)),
a mesma API que os workers usam por baixo.

Gera 3 versões da MESMA frase, todas com um pequeno pre-roll de silêncio
(mesmo achado desta rodada: o início da resposta pode estar sendo cortado
literalmente ou só ficando difícil de entender por começar "em cima" da
primeira sílaba sem margem):

  A) length_scale=1.00 (velocidade atual, sem mudança)
  B) length_scale=1.10 (~10% mais lenta)
  C) length_scale=1.15 (~15% mais lenta)

length_scale é um parâmetro nativo do Piper que escala a DURAÇÃO dos
fonemas -- não altera pitch (frequência), só cadência.

Uso: python benchmark_tts_speed.py
"""
import audioop
import json
import os
import time
import wave

from piper import PiperVoice
from piper.config import SynthesisConfig

MODELO = r"C:\Users\msi\Projeto Claude Code\voice-models\pt_BR-faber-medium.onnx"
SAIDA_DIR = os.path.join(os.path.dirname(__file__), "benchmark-output")
TELEFONIA_SAMPLE_RATE = 8000
PREROLL_MS = 200  # dentro da faixa pedida (150-300ms)

FRASE = "Claro. Vou encaminhar seu atendimento para uma pessoa da nossa equipe."

VARIANTES = [
    ("A-atual", 1.00),
    ("B-10pct-mais-lenta", 1.10),
    ("C-15pct-mais-lenta", 1.15),
]


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


def aplicar_preroll(wav_path, preroll_ms, sample_width):
    n_amostras_silencio = int(TELEFONIA_SAMPLE_RATE * preroll_ms / 1000)
    silencio = b"\x00" * (n_amostras_silencio * sample_width)

    with wave.open(wav_path, "rb") as wav_in:
        params = wav_in.getparams()
        frames = wav_in.readframes(wav_in.getnframes())

    frames_com_preroll = silencio + frames
    with wave.open(wav_path, "wb") as wav_out:
        wav_out.setparams(params)
        wav_out.writeframes(frames_com_preroll)

    return frames_com_preroll


def gravar_ulaw(wav_path, frames_8k_16bit, sample_width):
    frames_16bit = frames_8k_16bit if sample_width == 2 else audioop.lin2lin(frames_8k_16bit, sample_width, 2)
    ulaw_bytes = audioop.lin2ulaw(frames_16bit, 2)
    ulaw_path = os.path.splitext(wav_path)[0] + ".ulaw"
    with open(ulaw_path, "wb") as f:
        f.write(ulaw_bytes)
    return ulaw_path


def main():
    os.makedirs(SAIDA_DIR, exist_ok=True)

    t0 = time.time()
    voice = PiperVoice.load(MODELO)
    load_ms = int((time.time() - t0) * 1000)
    print(f"modelo carregado: load_ms={load_ms}")

    resultados = []
    for nome, length_scale in VARIANTES:
        wav_path = os.path.join(SAIDA_DIR, f"velocidade-{nome}.wav")

        t0 = time.time()
        syn_config = SynthesisConfig(length_scale=length_scale)
        with wave.open(wav_path, "wb") as wav_file:
            voice.synthesize_wav(FRASE, wav_file, syn_config=syn_config)
        synth_ms = int((time.time() - t0) * 1000)

        frames, sample_width = resample_para_telefonia(wav_path)
        frames_com_preroll = aplicar_preroll(wav_path, PREROLL_MS, sample_width)
        ulaw_path = gravar_ulaw(wav_path, frames_com_preroll, sample_width)

        with wave.open(wav_path, "rb") as wav_file:
            duracao_total_ms = int((wav_file.getnframes() / wav_file.getframerate()) * 1000)
        duracao_fala_ms = duracao_total_ms - PREROLL_MS

        resultados.append({
            "variante": nome, "length_scale": length_scale,
            "TTS_synth_ms": synth_ms, "audio_preroll_ms": PREROLL_MS,
            "duracao_fala_ms": duracao_fala_ms, "duracao_total_ms": duracao_total_ms,
            "wav_path": wav_path, "ulaw_path": ulaw_path,
        })
        print(f"{nome}: length_scale={length_scale} TTS_synth_ms={synth_ms} duracao_fala_ms={duracao_fala_ms} arquivo={wav_path}")

    print("\n" + json.dumps(resultados, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
