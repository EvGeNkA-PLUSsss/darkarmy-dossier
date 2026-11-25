#!/usr/bin/env python
"""faster-whisper STT для Darcus.

Аргументы: model_path_or_size audio_file [language]
Подсказки/исправления берутся из env:
  STT_HOTWORDS        — слова-подсказки для декодера (реферат, документ, Darcus…)
  STT_INITIAL_PROMPT  — начальный prompt (контекст фразы)
"""
import json
import os
import re
import sys

# Слова, которые часто встречаются в диктовке по файлам и проектам.
DEFAULT_HOTWORDS = (
    'реферат, документ, проект, файл, папка, изображение, распознавание, '
    'контекст, Darcus, Dossier, DarkArmy, Silero, Whisper, администратор, '
    'подписка, приглашение, наказание, телеметрия, OCR, чат, сообщение'
)
DEFAULT_PROMPT = (
    'Пользователь надиктовывает запрос или текст документа для проекта '
    'DarkArmy Dossier. В речи часто встречаются слова: реферат, документ, '
    'проект, файл, Darcus, распознавание, контекст.'
)

# Точечные автоисправления типичных ошибок распознавания.
CORRECTIONS = [
    (re.compile(r'\bре[а-яё]{1,4}рат[а-яё]*\b', re.IGNORECASE), 'реферат'),
    (re.compile(r'\bдакумент[а-яё]*\b', re.IGNORECASE), 'документ'),
    (re.compile(r'\bдакумент\w*', re.IGNORECASE), 'документ'),
    (re.compile(r'\bпроэкт[а-яё]*\b', re.IGNORECASE), 'проект'),
    (re.compile(r'\bраспозновани[а-яё]*\b', re.IGNORECASE), 'распознавание'),
    (re.compile(r'\bраспознован\w*', re.IGNORECASE), 'распознавание'),
    (re.compile(r'\bда[р]?кус\w*', re.IGNORECASE), 'Darcus'),
    (re.compile(r'\bдоси[её]\w*', re.IGNORECASE), 'Dossier'),
    (re.compile(r'\bдарк\s*арми\w*', re.IGNORECASE), 'DarkArmy'),
    (re.compile(r'\bвайспер\w*', re.IGNORECASE), 'Whisper'),
    (re.compile(r'\bсилеро\w*', re.IGNORECASE), 'Silero'),
]


def _same_case(original: str, replacement: str) -> str:
    if original[:1].isupper():
        return replacement[:1].upper() + replacement[1:]
    return replacement


def correct_text(text: str) -> str:
    for rx, repl in CORRECTIONS:
        text = rx.sub(lambda m, r=repl: _same_case(m.group(0), r), text)
    return text


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
    hotwords = os.environ.get('STT_HOTWORDS') or DEFAULT_HOTWORDS
    prompt = os.environ.get('STT_INITIAL_PROMPT') or DEFAULT_PROMPT
    segments, info = model.transcribe(
        audio,
        language=lang,
        vad_filter=True,
        beam_size=5,
        hotwords=hotwords,
        initial_prompt=prompt,
    )
    text = ' '.join((s.text or '').strip() for s in segments).strip()
    text = correct_text(text)
    payload = json.dumps({'text': text, 'language': getattr(info, 'language', lang)}, ensure_ascii=False)
    # Windows-консоль по умолчанию cp1251 — принудительно отдаём UTF-8,
    # иначе Node/UI получают кракозябры или знаки вопроса.
    sys.stdout.buffer.write((payload + '\n').encode('utf-8'))
    sys.stdout.flush()
    return 0


if __name__ == '__main__':
    sys.exit(main())
