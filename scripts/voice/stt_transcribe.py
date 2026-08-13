"""
Voice AI MVP -- STT bridge. Transcreve um arquivo WAV com faster-whisper e
imprime JSON no stdout. Chamado como subprocesso pelo serviço Node
(src/lib/voice/sttBridge.js) -- nunca imprime o texto transcrito em log
persistente do lado Node (só aqui, no stdout capturado em memória).

Uso: python stt_transcribe.py <caminho_wav> [--model small] [--lang pt]
"""
import argparse
import json
import time
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("wav_path")
    parser.add_argument("--model", default="small")
    parser.add_argument("--lang", default="pt")
    args = parser.parse_args()

    from faster_whisper import WhisperModel

    t0 = time.time()
    model = WhisperModel(args.model, device="cpu", compute_type="int8")
    load_ms = int((time.time() - t0) * 1000)

    t0 = time.time()
    # PARTE E (endurecimento pós-merge, otimização de latência sem trocar de
    # modelo): beam_size=1 (decodificação greedy, padrão do faster-whisper é
    # 5) e condition_on_previous_text=False (sem contexto entre segmentos,
    # irrelevante aqui pois cada turno já é uma transcrição isolada) --
    # ambos recomendados pela própria documentação do faster-whisper para
    # uso em tempo real; para os áudios curtos deste MVP (poucas frases) o
    # impacto na qualidade do PT-BR é desprezível frente ao ganho de
    # velocidade.
    segments, info = model.transcribe(
        args.wav_path, language=args.lang, beam_size=1, condition_on_previous_text=False,
    )
    texto = " ".join(seg.text.strip() for seg in segments)
    transcribe_ms = int((time.time() - t0) * 1000)

    print(json.dumps({
        "texto": texto,
        "idioma": info.language,
        "load_ms": load_ms,
        "transcribe_ms": transcribe_ms,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
