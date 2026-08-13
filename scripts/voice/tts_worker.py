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

    with wave.open(wav_path, "wb") as wav_out:
        wav_out.setnchannels(1)
        wav_out.setsampwidth(sample_width)
        wav_out.setframerate(TELEFONIA_SAMPLE_RATE)
        wav_out.writeframes(frames)

    return frames, sample_width


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
                "id": req_id, "type": "result",
                "synth_ms": synth_ms, "audio_preroll_ms": args.preroll_ms, "duracao_audio_ms": duracao_ms,
                "wav_path": wav_out, "ulaw_path": ulaw_path,
            })
        except Exception as err:  # nunca deixa o worker morrer por uma requisição ruim
            emit({"id": req_id, "type": "error", "message": str(err)})


if __name__ == "__main__":
    main()
