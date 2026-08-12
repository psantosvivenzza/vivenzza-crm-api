"""
Voice AI MVP -- TTS bridge. Sintetiza texto em WAV com Piper e imprime JSON
no stdout (timing). Chamado como subprocesso pelo serviço Node
(src/lib/voice/ttsBridge.js).

Uso: python tts_synthesize.py <texto> <caminho_wav_saida> [--model caminho.onnx]
"""
import argparse
import json
import time
import wave


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("texto")
    parser.add_argument("wav_saida")
    parser.add_argument("--model", default=r"C:\Users\msi\Projeto Claude Code\voice-models\pt_BR-faber-medium.onnx")
    args = parser.parse_args()

    from piper import PiperVoice

    t0 = time.time()
    voice = PiperVoice.load(args.model)
    load_ms = int((time.time() - t0) * 1000)

    t0 = time.time()
    with wave.open(args.wav_saida, "wb") as wav_file:
        voice.synthesize_wav(args.texto, wav_file)
    synth_ms = int((time.time() - t0) * 1000)

    with wave.open(args.wav_saida, "rb") as wav_file:
        duracao_ms = int((wav_file.getnframes() / wav_file.getframerate()) * 1000)

    print(json.dumps({
        "wav_path": args.wav_saida,
        "load_ms": load_ms,
        "synth_ms": synth_ms,
        "duracao_audio_ms": duracao_ms,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
