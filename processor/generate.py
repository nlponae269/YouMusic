#!/usr/bin/env python3
"""Генерация песен нейросетью ACE-Step 1.5 (бесплатно, на процессоре GitHub Actions).

Заявка с сайта — строка в tracks со source_path «<uid>/<id>.gen» и JSON-файл с параметрами
в бакете incoming. Генератор:
  1. убирает из текста и описания запрещённые слова, чтобы модель их даже не спела;
  2. генерирует песню и кладёт MP3 в incoming как обычную загрузку;
  3. возвращает трек в очередь — дальше его проверяет обычная цензура (Demucs + Whisper).

Переменные окружения: SUPABASE_URL, SUPABASE_SERVICE_KEY, ACE_REPO (папка с кодом ACE-Step),
MAX_GENERATIONS (сколько песен за запуск, по умолчанию 3).
"""
import json
import os
import re
import shutil
import sys
import tempfile
import time
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import process as P  # noqa: E402  (запросы к Supabase)
from words import censor_text  # noqa: E402

ACE_REPO = Path(os.environ.get("ACE_REPO", "ace-step")).resolve()
MAX_GENERATIONS = int(os.environ.get("MAX_GENERATIONS", "3"))
# языковая модель ACE-Step на процессоре слишком медленная — генерируем без неё
NEEDED = ["acestep-v15-turbo/*", "vae/*", "Qwen3-Embedding-0.6B/*", "config.json"]


def clean(text, limit):
    """Вырезает запрещённые слова целиком (а не звёздочками) — модель не должна их петь."""
    censored, _ = censor_text(text or "")
    censored = re.sub(r"\*+", "", censored)
    censored = re.sub(r"[ \t]{2,}", " ", censored)
    return "\n".join(line.strip() for line in censored.splitlines()).strip()[:limit]


def display_lyrics(lyrics):
    """Текст для сайта: без служебных пометок вроде [Verse] и [Chorus]."""
    lines = [ln for ln in lyrics.splitlines() if not re.fullmatch(r"\s*\[[^\]]*\]\s*", ln)]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def load_model():
    sys.path.insert(0, str(ACE_REPO))
    from huggingface_hub import snapshot_download
    import acestep.model_downloader as md
    from acestep.handler import AceStepHandler

    md.MAIN_MODEL_COMPONENTS[:] = [c for c in md.MAIN_MODEL_COMPONENTS if "5Hz-lm" not in c]
    snapshot_download("ACE-Step/Ace-Step1.5", local_dir=str(ACE_REPO / "checkpoints"), allow_patterns=NEEDED)
    # на процессоре звук собирается небольшими кусками, чтобы хватило памяти
    os.environ.setdefault("ACESTEP_VAE_DECODE_CHUNK_SIZE", "64")
    handler = AceStepHandler()
    msg, ok = handler.initialize_service(project_root=str(ACE_REPO), config_path="acestep-v15-turbo",
                                         device="cpu", offload_to_cpu=False)
    if not ok:
        raise RuntimeError(f"ACE-Step не запустился: {msg}")
    return handler


def generate(handler, req, out_dir):
    from acestep.inference import GenerationConfig, GenerationParams, generate_music

    params = GenerationParams(
        task_type="text2music",
        thinking=False,
        caption=req["caption"],
        lyrics=req["lyrics"] or "[Instrumental]",
        vocal_language=req["language"],
        duration=req["duration"],
        inference_steps=8,
        guidance_scale=1.0,
        seed=-1,
    )
    res = generate_music(handler, None, params=params,
                         config=GenerationConfig(batch_size=1, audio_format="mp3"), save_dir=str(out_dir))
    if not res.success or not res.audios:
        raise RuntimeError(f"Генерация не удалась: {res.status_message}")
    return Path(res.audios[0]["path"])


def main():
    queue = P.db("GET", f"tracks?status=eq.pending&source_path=like.*.gen&order=created_at.asc&limit={MAX_GENERATIONS}") or []
    print(f"Заявок на генерацию: {len(queue)}", flush=True)
    if not queue:
        return
    handler = load_model()
    for t in queue:
        taken = P.db("PATCH", f"tracks?id=eq.{t['id']}&status=eq.pending",
                     {"status": "processing", "processing_started": P.now_iso()})
        if not taken:
            continue
        print(f"♪ Генерирую «{t['title']}»", flush=True)
        work = Path(tempfile.mkdtemp(prefix="ym-gen-"))
        try:
            req_file = work / "request.json"
            P.storage_download("incoming", t["source_path"], req_file)
            raw = json.loads(req_file.read_text(encoding="utf-8"))
            req = {
                "caption": clean(raw.get("caption"), 500) or "pop song",
                "lyrics": "" if raw.get("instrumental") else clean(raw.get("lyrics"), 4000),
                "language": raw.get("language") if raw.get("language") in ("ru", "en") else "ru",
                "duration": max(20, min(180, int(raw.get("duration") or 60))),
            }
            started = time.time()
            mp3 = generate(handler, req, work)
            print(f"  готово за {time.time() - started:.0f} с", flush=True)
            uid = t["source_path"].split("/")[0]
            new_path = f"{uid}/{t['id']}.mp3"
            P.storage_upload("incoming", new_path, mp3, "audio/mpeg")
            # обратно в очередь: дальше трек проверяет обычная цензура
            P.db("PATCH", f"tracks?id=eq.{t['id']}", {
                "status": "pending",
                "source_path": new_path,
                "album": P.AI_ALBUM,
                "lyrics": display_lyrics(req["lyrics"]) or None,
            })
            P.storage_delete("incoming", [t["source_path"]])
        except Exception as err:  # noqa: BLE001
            traceback.print_exc()
            P.db("PATCH", f"tracks?id=eq.{t['id']}", {"status": "failed", "error": str(err)[:500]})
            P.storage_delete("incoming", [t["source_path"]])
        finally:
            shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
