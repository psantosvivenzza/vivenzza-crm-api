"""
Voice AI -- teste controlado A/B/C de noise_scale (hipótese: variação
estocástica do Piper/VITS explica o "chiado" reportado numa das gerações
reais). Mesma voz (Jeff), mesmo length_scale, mesmo noise_w, mesma frase --
só noise_scale varia -- com 3 repetições independentes por configuração
pra também mostrar a variação natural DENTRO de cada config. Não toca em
config principal, não gera .ulaw (decisão é só por ouvido, local).
"""
import os
import wave

from piper import PiperVoice
from piper.config import SynthesisConfig

MODELO = r"C:\Users\msi\Projeto Claude Code\voice-models\pt_BR-jeff-medium.onnx"
SAIDA_DIR = r"C:\Users\msi\AppData\Local\Temp\vivenzza-noise-test"
LENGTH_SCALE = 1.00
NOISE_W = 0.8
FRASE = "Claro. Vou encaminhar seu atendimento para uma pessoa da nossa equipe."
REPETICOES = 3

CONFIGS = [
    ("A-default", 0.667),
    ("B-noise030", 0.30),
    ("C-noise000", 0.00),
]


def main():
    os.makedirs(SAIDA_DIR, exist_ok=True)
    voice = PiperVoice.load(MODELO)

    for prefixo, noise_scale in CONFIGS:
        syn_config = SynthesisConfig(length_scale=LENGTH_SCALE, noise_scale=noise_scale, noise_w_scale=NOISE_W)
        for i in range(1, REPETICOES + 1):
            nome = f"{prefixo}-{i}.wav"
            caminho = os.path.join(SAIDA_DIR, nome)
            with wave.open(caminho, "wb") as wf:
                voice.synthesize_wav(FRASE, wf, syn_config=syn_config)
            with wave.open(caminho, "rb") as w:
                dur_ms = round(w.getnframes() / w.getframerate() * 1000)
            print(f"{nome}: noise_scale={noise_scale} noise_w={NOISE_W} duracao_ms={dur_ms}")


if __name__ == "__main__":
    main()
