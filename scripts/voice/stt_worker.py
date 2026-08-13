"""
Voice AI -- worker STT PERSISTENTE. Sobe uma vez, carrega o WhisperModel UMA
vez, e fica servindo requisições de transcrição via stdin/stdout (protocolo
JSON delimitado por linha) enquanto o processo Node pai estiver vivo --
elimina o load_ms (~2.3s) que o script antigo (stt_transcribe.py, mantido
como fallback) pagava em TODO turno.

Protocolo (uma linha JSON por mensagem, em ambas direções):
  Node -> worker: {"id": 1, "wav_path": "...", "lang": "pt"}
  worker -> Node (pronto):     {"type": "ready", "load_ms": 2353}
  worker -> Node (resultado):  {"id": 1, "type": "result", "texto": "...",
                                 "idioma": "pt", "transcribe_ms": 210}
  worker -> Node (erro):       {"id": 1, "type": "error", "message": "..."}

Uso: python stt_worker.py --model small
"""
import argparse
import json
import sys
import time


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="small")
    args = parser.parse_args()

    from faster_whisper import WhisperModel

    t0 = time.time()
    model = WhisperModel(args.model, device="cpu", compute_type="int8")
    load_ms = int((time.time() - t0) * 1000)
    emit({"type": "ready", "load_ms": load_ms})

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
        wav_path = req.get("wav_path")
        lang = req.get("lang", "pt")
        try:
            t0 = time.time()
            # Mesmo tuning de latência do script legado (PARTE E, PR #17):
            # beam_size=1 + condition_on_previous_text=False.
            segments, info = model.transcribe(
                wav_path, language=lang, beam_size=1, condition_on_previous_text=False,
            )
            texto = " ".join(seg.text.strip() for seg in segments)
            transcribe_ms = int((time.time() - t0) * 1000)
            emit({
                "id": req_id, "type": "result",
                "texto": texto, "idioma": info.language, "transcribe_ms": transcribe_ms,
            })
        except Exception as err:  # nunca deixa o worker morrer por uma requisição ruim
            emit({"id": req_id, "type": "error", "message": str(err)})


if __name__ == "__main__":
    main()
