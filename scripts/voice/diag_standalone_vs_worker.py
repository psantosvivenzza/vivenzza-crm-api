"""
Voice AI -- diagnóstico pontual: compara STANDALONE (voice.load() fresco,
usado 1x) vs WORKER-LIKE (mesmo objeto de voz REUTILIZADO várias vezes
antes da frase de teste, replicando exatamente o padrão real: saudação +
feedback + resposta1 + resposta2 + frase de teste, tudo no MESMO processo/
voice object -- que é como o tts_worker.py realmente opera). Mesmo modelo,
mesmo arquivo .onnx, mesmos parâmetros (length_scale=1.00, noise_scale/
noise_w default do modelo = não sobrescritos em nenhum dos dois casos).
"""
import audioop
import hashlib
import json
import struct
import wave

from piper import PiperVoice
from piper.config import SynthesisConfig

MODELO = r"C:\Users\msi\Projeto Claude Code\voice-models\pt_BR-jeff-medium.onnx"
SAIDA_DIR = r"C:\Users\msi\AppData\Local\Temp\vivenzza-vozes"
TELEFONIA_SAMPLE_RATE = 8000
LENGTH_SCALE = 1.00
PREROLL_MS = 200
FRASE_TESTE = "Claro. Vou encaminhar seu atendimento para uma pessoa da nossa equipe."

# Textos reais que o worker sintetizou ANTES da resposta de teste nessa
# sessão real de ligação (mesma ordem: saudação -> feedback -> resposta1 ->
# resposta2), pra reproduzir o mesmo histórico de reuso do objeto de voz.
SAUDACAO = "Olá. Este é um teste interno do assistente de voz da Vivenzza. Pode falar depois do sinal."
FEEDBACK = "Só um instante enquanto verifico isso."
RESPOSTA1 = "Certo! Estamos aqui para ajudar. Há algo mais em que posso auxiliar você?"
RESPOSTA2 = "Entendido. Vou transferir você para um de nossos atendentes."


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
    n = int(TELEFONIA_SAMPLE_RATE * preroll_ms / 1000)
    silencio = b"\x00" * (n * sample_width)
    with wave.open(wav_path, "rb") as wav_in:
        params = wav_in.getparams()
        frames = wav_in.readframes(wav_in.getnframes())
    with wave.open(wav_path, "wb") as wav_out:
        wav_out.setparams(params)
        wav_out.writeframes(silencio + frames)


def analisar_ruido(path, rotulo):
    with wave.open(path, "rb") as w:
        sr = w.getframerate()
        sw = w.getsampwidth()
        frames = w.readframes(w.getnframes())
    amostras = struct.unpack("<%dh" % (len(frames) // 2), frames)
    n = len(amostras)
    preroll_amostras = int(sr * 0.200)
    preroll = amostras[:preroll_amostras] if n > preroll_amostras else amostras
    rms_preroll = audioop.rms(struct.pack("<%dh" % len(preroll), *preroll), sw) if preroll else 0
    rms_total = audioop.rms(frames, sw)
    peak = max(abs(a) for a in amostras)
    clipping = sum(1 for a in amostras if abs(a) >= 32760)
    # proxy simples de "chiado": variação amostra-a-amostra em alta frequência
    diffs = [abs(amostras[i + 1] - amostras[i]) for i in range(0, n - 1, 20)]
    diff_medio = sum(diffs) / len(diffs) if diffs else 0
    print(f"{rotulo}: sr={sr} dur_ms={round(n/sr*1000)} rms_preroll={rms_preroll} rms_total={rms_total} peak={peak} clipping_amostras={clipping} diff_medio_HF={round(diff_medio,1)}")


def gerar(nome_base, incluir_historico):
    voice = PiperVoice.load(MODELO)
    syn_config = SynthesisConfig(length_scale=LENGTH_SCALE)

    if incluir_historico:
        # reproduz o MESMO padrão de reuso do worker real antes da frase de teste
        for texto in (SAUDACAO, FEEDBACK, RESPOSTA1, RESPOSTA2):
            tmp = SAIDA_DIR + r"\_descartavel.wav"
            with wave.open(tmp, "wb") as wf:
                voice.synthesize_wav(texto, wf, syn_config=syn_config)

    native_path = f"{SAIDA_DIR}\\{nome_base}-native.wav"
    with wave.open(native_path, "wb") as wf:
        voice.synthesize_wav(FRASE_TESTE, wf, syn_config=syn_config)

    with wave.open(native_path, "rb") as w:
        sr_nativo = w.getframerate()
    analisar_ruido(native_path, f"{nome_base}-native (sr={sr_nativo}, ANTES do resample)")

    k8_path = f"{SAIDA_DIR}\\{nome_base}-8k.wav"
    import shutil
    shutil.copyfile(native_path, k8_path)
    sample_width = resample_para_telefonia(k8_path)
    aplicar_preroll(k8_path, PREROLL_MS, sample_width)
    analisar_ruido(k8_path, f"{nome_base}-8k (depois do resample+preroll)")


def main():
    with open(MODELO, "rb") as f:
        print("sha256 modelo:", hashlib.sha256(f.read()).hexdigest())
    with open(MODELO + ".json", "r", encoding="utf-8") as f:
        cfg = json.load(f)
    print("config json (defaults do modelo):", json.dumps(cfg.get("inference", cfg)))
    print(f"length_scale usado explicitamente: {LENGTH_SCALE} (noise_scale/noise_w NÃO sobrescritos em nenhum dos dois -- usam o default do modelo acima)")
    print()

    print("=== STANDALONE (voice fresco, uso único) ===")
    gerar("jeff-standalone", incluir_historico=False)

    print("\n=== WORKER-LIKE (mesmo objeto de voz reutilizado: saudacao+feedback+resposta1+resposta2 antes da frase de teste) ===")
    gerar("jeff-worker", incluir_historico=True)


if __name__ == "__main__":
    main()
