#!/usr/bin/env python
"""faster-whisper STT для Darcus. Аргументы: model_path_or_size audio_file [language]."""
import sys
import json


def main():
    model_name = sys.argv[1] if len(sys.argv) > 1 else 'base'
    audio = sys.argv[2]
    lang = sys.argv[3] if len(sys.argv) > 3 else 'ru'
    try:
        from faster_whisper import WhisperModel
    except Exception as e:
        msg = json.dumps({'error': 'faster-whisper не установлен: ' + str(e)}, ensure_ascii=False)
        sys.stdout.buffer.write((msg + '\n').encode('utf-8'))
        return 2
    model = WhisperModel(model_name, device='cpu', compute_type='int8')
    segments, info = model.transcribe(audio, language=lang, vad_filter=True, beam_size=1)
    text = ' '.join((s.text or '').strip() for s in segments).strip()
    payload = json.dumps({'text': text, 'language': getattr(info, 'language', lang)}, ensure_ascii=False)
    # Windows-консоль по умолчанию cp1251 — принудительно отдаём UTF-8,
    # иначе Node/UI получают кракозябры или знаки вопроса.
    sys.stdout.buffer.write((payload + '\n').encode('utf-8'))
    sys.stdout.flush()
    return 0


if __name__ == '__main__':
    sys.exit(main())
