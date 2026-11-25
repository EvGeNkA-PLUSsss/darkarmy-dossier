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
        print(json.dumps({'error': 'faster-whisper не установлен: ' + str(e)}, ensure_ascii=False))
        return 2
    model = WhisperModel(model_name, device='cpu', compute_type='int8')
    segments, info = model.transcribe(audio, language=lang, vad_filter=True, beam_size=1)
    text = ' '.join((s.text or '').strip() for s in segments).strip()
    print(json.dumps({'text': text, 'language': getattr(info, 'language', lang)}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
