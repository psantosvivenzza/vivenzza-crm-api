"""
Voice AI -- gera amostras SIMPLES pra escuta humana fora do telefone,
comparando as 3 vozes Piper pt-BR (faber/cadu/jeff) com length_scale=1.00
(voltando a velocidade normal, só o preroll=200ms mantido). Não toca em
config principal, não usa Asterisk/ulaw -- só WAV, fácil de abrir no
Windows.
"""
import audioop
import os
import wave

from piper import PiperVoice
from piper.config import SynthesisConfig

VOICES_DIR = r"C:\Users\msi\Projeto Claude Code\voice-models"
SAIDA_DIR = r"C:\Users\msi\AppData\Local\Temp\vivenzza-vozes"
TELEFONIA_SAMPLE_RATE = 8000
LENGTH_SCALE = 1.00
PREROLL_MS = 200

VOZES = [
    ("faber", os.path.join(VOICES_DIR, "pt_BR-faber-medium.onnx")),
    ("cadu", os.path.join(VOICES_DIR, "pt_BR-cadu-medium.onnx")),
    ("jeff", os.path.join(VOICES_DIR, "pt_BR-jeff-medium.onnx")),
]

FRASES = [
    ("1", "Olá. Este é o assistente virtual da Vivenzza. Como posso ajudar?"),
    ("2", "Claro. Vou encaminhar seu atendimento para uma pessoa da nossa equipe."),
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
    return sample_width


def aplicar_preroll(wav_path, preroll_ms, sample_width):
    n_amostras_silencio = int(TELEFONIA_SAMPLE_RATE * preroll_ms / 1000)
    silencio = b"\x00" * (n_amostras_silencio * sample_width)
    with wave.open(wav_path, "rb") as wav_in:
        params = wav_in.getparams()
        frames = wav_in.readframes(wav_in.getnframes())
    with wave.open(wav_path, "wb") as wav_out:
        wav_out.setparams(params)
        wav_out.writeframes(silencio + frames)


def main():
    os.makedirs(SAIDA_DIR, exist_ok=True)
    syn_config = SynthesisConfig(length_scale=LENGTH_SCALE)

    for nome_voz, modelo_path in VOZES:
        voice = PiperVoice.load(modelo_path)
        for numero, texto in FRASES:
            nome_arquivo = f"voz-{nome_voz}-{numero}.wav"
            saida_path = os.path.join(SAIDA_DIR, nome_arquivo)

            with wave.open(saida_path, "wb") as wav_file:
                voice.synthesize_wav(texto, wav_file, syn_config=syn_config)

            sample_width = resample_para_telefonia(saida_path)
            aplicar_preroll(saida_path, PREROLL_MS, sample_width)

            with wave.open(saida_path, "rb") as w:
                duracao_ms = int(w.getnframes() / w.getframerate() * 1000)
            print(f"{nome_arquivo}: duracao_ms={duracao_ms} -> {saida_path}")


if __name__ == "__main__":
    main()
