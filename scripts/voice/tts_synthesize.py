"""
Voice AI MVP -- TTS bridge. Sintetiza texto em WAV com Piper e imprime JSON
no stdout (timing). Chamado como subprocesso pelo serviço Node
(src/lib/voice/ttsBridge.js).

ACHADO REAL #1 (homologação da 1a ligação interna): Piper gera nativamente
em 22050Hz mono 16-bit -- não é o formato de telefonia (8000Hz). Resample
pra 8000Hz mono 16-bit aqui, via audioop (stdlib, sem SoX/dependência nova).

ACHADO REAL #2 (mesma homologação, log do PRÓPRIO Asterisk --
/var/log/asterisk/messages.log): mesmo em 8kHz, o Asterisk rejeitava o WAV
com "File ... does not exist in any format" / "Unable to open ... (format
(ulaw))" -- o parser de WAV do Asterisk é notoriamente restrito (só aceita
uma variante bem específica de PCM WAV) e não reconhecia a saída do Python
`wave`, mesmo sendo PCM 8kHz/16-bit/mono válido. Fix definitivo: gravar
TAMBÉM uma cópia em .ulaw bruto (G.711 mu-law, sem nenhum container/header
-- exatamente o formato que a mensagem de erro do Asterisk pedia
explicitamente) via audioop.lin2ulaw. O Asterisk sempre entende .ulaw
nativamente, sem depender do parser de WAV.

Uso: python tts_synthesize.py <texto> <caminho_wav_saida> [--model caminho.onnx]
Grava também <caminho_wav_saida> com extensão trocada para .ulaw.
"""
import argparse
import audioop
import json
import os
import time
import wave

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
    parser.add_argument("texto")
    parser.add_argument("wav_saida")
    parser.add_argument("--model", default=r"C:\Users\msi\Projeto Claude Code\voice-models\pt_BR-jeff-medium.onnx")
    # Mesma calibragem final validada por amostras nesta rodada de UX de
    # voz (ver tts_worker.py) -- este script é só o fallback (subprocesso
    # avulso), mantido consistente com o worker pra não soar diferente se o
    # fallback for ativado. A voz em si (Jeff vs Faber) vem de --model.
    parser.add_argument("--length-scale", type=float, default=1.00)
    parser.add_argument("--preroll-ms", type=int, default=200)
    args = parser.parse_args()

    from piper import PiperVoice
    from piper.config import SynthesisConfig

    t0 = time.time()
    voice = PiperVoice.load(args.model)
    load_ms = int((time.time() - t0) * 1000)

    t0 = time.time()
    with wave.open(args.wav_saida, "wb") as wav_file:
        voice.synthesize_wav(args.texto, wav_file, syn_config=SynthesisConfig(length_scale=args.length_scale))
    synth_ms = int((time.time() - t0) * 1000)

    frames, sample_width = resample_para_telefonia(args.wav_saida)
    frames_com_preroll = aplicar_preroll(args.wav_saida, args.preroll_ms, sample_width)
    ulaw_path = gravar_ulaw(args.wav_saida, frames_com_preroll, sample_width)

    with wave.open(args.wav_saida, "rb") as wav_file:
        duracao_ms = int((wav_file.getnframes() / wav_file.getframerate()) * 1000)

    print(json.dumps({
        "wav_path": args.wav_saida,
        "ulaw_path": ulaw_path,
        "load_ms": load_ms,
        "synth_ms": synth_ms,
        "audio_preroll_ms": args.preroll_ms,
        "duracao_audio_ms": duracao_ms,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
