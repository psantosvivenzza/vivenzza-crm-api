"""
Voice AI -- worker TTS PERSISTENTE. Sobe uma vez, carrega o PiperVoice UMA
vez, e fica servindo requisições de síntese via stdin/stdout (protocolo JSON
delimitado por linha) -- elimina o load_ms (~2s) que o script antigo
(tts_synthesize.py, mantido como fallback) pagava em TODA síntese.

Mesma lógica de pós-processamento do script legado (resample pra telefonia +
gravação de .ulaw ao lado do .wav), só que sem recarregar o modelo.

ACHADO (endurecimento de UX pós-persistent-workers, investigação completa):
uma primeira tentativa de length_scale=1.10 (~10% mais devagar) foi
testada e REJEITADA pelo ouvido humano — ouvindo o .wav bruto direto no
Windows (fora de qualquer telefonia/Asterisk), a voz pt_BR-faber-medium
soou "rápida/estranha e difícil de entender" mesmo assim, confirmando que
o problema não era codec/sample-rate/resample (todos os estágios do
pipeline foram inspecionados e batem exatamente). Comparando 3 vozes
Piper pt-BR lado a lado (faber/cadu/jeff) com length_scale=1.00, a voz
JEFF (pt_BR-jeff-medium) foi aprovada. Decisão final: length_scale=1.00
(velocidade nativa do modelo, sem ajuste) + pre-roll de 200ms de silêncio
antes da 1ª sílaba (o canal já está "tocando" quando a fala realmente
começa). Ambos configuráveis via env (VOICE_TTS_LENGTH_SCALE/
VOICE_TTS_PREROLL_MS) sem precisar mexer neste arquivo se a calibragem
mudar depois. A VOZ em si é escolhida via --model (VOICE_TTS_MODEL_PATH no
Node), não neste arquivo.

Protocolo (uma linha JSON por mensagem, em ambas direções):
  Node -> worker: {"id": 1, "texto": "...", "wav_out": "C:\\...\\out.wav"}
  worker -> Node (pronto):     {"type": "ready", "load_ms": 2028}
  worker -> Node (resultado):  {"id": 1, "type": "result", "synth_ms": 272,
                                 "audio_preroll_ms": 200, "duracao_audio_ms": 4353,
                                 "wav_path": "...", "ulaw_path": "..."}
  worker -> Node (erro):       {"id": 1, "type": "error", "message": "..."}

Uso: python tts_worker.py --model caminho.onnx [--length-scale 1.10] [--preroll-ms 200]
"""
import argparse
import audioop
import json
import struct
import math
import os
import sys
import time
import wave

TELEFONIA_SAMPLE_RATE = 8000


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


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

    frames = condicionar_para_telefonia(frames, sample_width) if CONDICIONAMENTO else normalizar_simples(frames, sample_width)

    with wave.open(wav_path, "wb") as wav_out:
        wav_out.setnchannels(1)
        wav_out.setsampwidth(sample_width)
        wav_out.setframerate(TELEFONIA_SAMPLE_RATE)
        wav_out.writeframes(frames)

    return frames, sample_width


# Liga/desliga o condicionamento agressivo. Padrao: DESLIGADO.
CONDICIONAMENTO = os.environ.get("VOICE_TTS_CONDICIONAMENTO", "off").strip().lower() in ("on", "1", "true", "sim")


def normalizar_simples(frames, sample_width):
    """Apenas nivela o volume. Sem filtro, sem pre-enfase.

    ACHADO DEFINITIVO (17/09/2026): capturamos o RTP pacote a pacote de uma
    ligacao real. O que sai do Asterisk e byte-identico ao arquivo -- 50
    pacotes/s, 160 bytes, zero perda, envelope e pico iguais aos do .wav
    fonte. Logo o problema NUNCA esteve no Asterisk, no codec, no resample
    nem no trunk: estava no condicionamento abaixo, que aplicava passa-alta
    de 300 Hz em dois passes (~24 dB de corte na fundamental de uma voz
    masculina, que vive em ~110 Hz) mais pre-enfase de 0,35 por cima.

    No alto-falante do PC isso soa "mais nitido" -- por isso o .wav parecia
    ter melhorado. No celular o AMR da operadora recebe uma voz sem corpo e
    com agudo empurrado e devolve fala fina, rapida e comendo letra, que foi
    exatamente o relato do cliente. Teste A/B de 4 variantes DENTRO DA MESMA
    LIGACAO (mesmo trunk, mesma operadora, mesmo aparelho) decidiu:
    pt_BR-cadu-medium, length_scale 1.10, SEM condicionamento.
    """
    if sample_width != 2:
        return frames
    n = len(frames) // 2
    if n == 0:
        return frames
    x = struct.unpack("<%dh" % n, frames)
    pico = max(1, max(abs(v) for v in x))
    ganho = 22000.0 / pico
    LIMITE = 32000
    saida = []
    for v in x:
        s = v * ganho
        if s > LIMITE:
            s = LIMITE
        elif s < -LIMITE:
            s = -LIMITE
        saida.append(int(s))
    return struct.pack("<%dh" % n, *saida)


def condicionar_para_telefonia(frames, sample_width):
    """DESATIVADO por padrao -- ver normalizar_simples(). Mantido para
    permitir volta atras via VOICE_TTS_CONDICIONAMENTO=on.

    Texto original do achado que motivou este filtro:

    ACHADO REAL (17/09/2026, primeiras ligacoes atendidas por clientes): o
    cliente relatou fala "enrolada". A analise do WAV gerado mostrou o porque:
    31,6% da energia abaixo de 300 Hz e apenas 13,7% entre 2 e 4 kHz. As
    consoantes, que sao o que distingue uma palavra da outra, vivem justamente
    nessa faixa alta. Sobrava grave (que na telefonia nem passa, so abafa) e
    faltava consoante.

    Tres etapas, todas padrao em audio de telefonia:
      1. Passa-alta em 300 Hz  - tira o ronco que mascara a fala.
      2. Pre-enfase leve       - levanta as consoantes de 2-4 kHz.
      3. Normalizacao com teto - fala com nivel constante e sem estalo no
                                 inicio (o WAV analisado batia 32.724 de
                                 32.767 logo na primeira silaba).
    """
    if sample_width != 2:
        return frames

    n = len(frames) // 2
    if n == 0:
        return frames
    x = list(struct.unpack("<%dh" % n, frames))

    # 1) Passa-alta de 1a ordem em ~300 Hz (dois passes = ~12 dB/oitava).
    #    coef = RC/(RC+dt), RC = 1/(2*pi*fc)
    fc = 300.0
    dt = 1.0 / TELEFONIA_SAMPLE_RATE
    rc = 1.0 / (2.0 * math.pi * fc)
    alpha = rc / (rc + dt)
    for _ in range(2):
        y = [0.0] * n
        anterior_x = x[0]
        anterior_y = 0.0
        for i in range(n):
            anterior_y = alpha * (anterior_y + x[i] - anterior_x)
            anterior_x = x[i]
            y[i] = anterior_y
        x = y

    # 2) Pre-enfase suave: realca as consoantes sem deixar a voz metalica.
    pre = 0.35
    z = [0.0] * n
    anterior = 0.0
    for i in range(n):
        z[i] = x[i] - pre * anterior
        anterior = x[i]
    x = z

    # 3) Normaliza pelo percentil alto (nao pelo pico absoluto, pra um unico
    #    estalo nao derrubar o volume da fala inteira) e limita o resto.
    magnitudes = sorted(abs(v) for v in x)
    referencia = magnitudes[int(0.995 * (n - 1))] or 1.0
    ALVO = 26000.0  # ~ -2 dBFS, com folga pra nao distorcer
    ganho = ALVO / referencia
    LIMITE = 32000
    saida = []
    for v in x:
        s = v * ganho
        if s > LIMITE:
            s = LIMITE
        elif s < -LIMITE:
            s = -LIMITE
        saida.append(int(s))

    return struct.pack("<%dh" % n, *saida)


def aplicar_preroll(wav_path, preroll_ms, sample_width):
    if preroll_ms <= 0:
        with wave.open(wav_path, "rb") as wav_in:
            return wav_in.readframes(wav_in.getnframes())

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


# Blindagem de encoding: no Windows o padrao do stdin/stdout e a code page
# do locale (cp1252), o que corrompe todo acento vindo do Node e faz o Piper
# FALAR o nome do simbolo ("copyright"). Forca UTF-8 nas duas pontas.
try:
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--length-scale", type=float, default=1.00)
    parser.add_argument("--preroll-ms", type=int, default=200)
    args = parser.parse_args()

    from piper import PiperVoice
    from piper.config import SynthesisConfig

    t0 = time.time()
    voice = PiperVoice.load(args.model)
    load_ms = int((time.time() - t0) * 1000)
    emit({"type": "ready", "load_ms": load_ms})

    syn_config = SynthesisConfig(length_scale=args.length_scale)

    for linha in sys.stdin:
        linha = linha.strip()
        if not linha:
            continue
        try:
            req = json.loads(linha)
        except json.JSONDecodeError as err:
            emit({"type": "error", "message": f"JSON inválido: {err}"})
            continue

        req_id = req.get("id")
        texto = req.get("texto")
        # Diagnostico de encoding: devolve o texto EXATO que chegou, para o
        # Node poder provar que nao houve mojibake no caminho.
        texto_recebido = texto
        wav_out = req.get("wav_out")
        try:
            t0 = time.time()
            with wave.open(wav_out, "wb") as wav_file:
                voice.synthesize_wav(texto, wav_file, syn_config=syn_config)
            synth_ms = int((time.time() - t0) * 1000)

            frames, sample_width = resample_para_telefonia(wav_out)
            frames_com_preroll = aplicar_preroll(wav_out, args.preroll_ms, sample_width)
            ulaw_path = gravar_ulaw(wav_out, frames_com_preroll, sample_width)

            with wave.open(wav_out, "rb") as wav_file:
                duracao_ms = int((wav_file.getnframes() / wav_file.getframerate()) * 1000)

            emit({
                "id": req_id, "type": "result", "texto_recebido": texto_recebido,
                "synth_ms": synth_ms, "audio_preroll_ms": args.preroll_ms, "duracao_audio_ms": duracao_ms,
                "wav_path": wav_out, "ulaw_path": ulaw_path,
            })
        except Exception as err:  # nunca deixa o worker morrer por uma requisição ruim
            emit({"id": req_id, "type": "error", "message": str(err)})


if __name__ == "__main__":
    main()
