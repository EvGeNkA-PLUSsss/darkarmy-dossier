#!/usr/bin/env python
"""Silero TTS HTTP-сервер для DarkArmy Dossier.

POST /tts  {"text":"...","voice":"aidar","format":"wav"} -> audio/wav
GET  /health -> {"ok":true,"model":"silero-v4-ru","sample_rate":48000}

Запуск:  python scripts/silero_tts_server.py --port 8765
Модель загружается через torch.hub (при первом запуске скачивается).
"""
import argparse
import io
import json
import wave
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import torch

MODEL = None
SR = 48000


def load_model():
    global MODEL, SR
    if MODEL is not None:
        return
    # Новый Silero через torch.hub возвращает (model, example_text), sample_rate
    # задаётся при синтезе. Поддерживаем и старый формат (model, sample_rate).
    loaded = torch.hub.load(
        'snakers4/silero-models', 'silero_tts',
        language='ru', speaker='v4_ru', trust_repo=True,
    )
    if isinstance(loaded, (tuple, list)) and len(loaded) >= 2 and isinstance(loaded[1], int):
        MODEL, SR = loaded[0], loaded[1]
    elif isinstance(loaded, (tuple, list)):
        MODEL, SR = loaded[0], 48000
    else:
        MODEL, SR = loaded, 48000
    MODEL.to(torch.device('cpu'))


def synth(text, speaker='aidar'):
    load_model()
    audio = MODEL.apply_tts(text=text[:2000], speaker=speaker or 'aidar', sample_rate=SR)
    arr = audio.numpy()
    if arr.ndim > 1:
        arr = arr.squeeze()
    pcm = (np.clip(arr, -1, 1) * 32767).astype('<i2')
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write(fmt % args + '\n')

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/health':
            self._json(200, {'ok': MODEL is not None, 'model': 'silero-v4-ru', 'sample_rate': SR})
        else:
            self._json(404, {'error': 'not found'})

    def do_POST(self):
        if self.path != '/tts':
            return self._json(404, {'error': 'not found'})
        try:
            length = int(self.headers.get('Content-Length') or 0)
            if length <= 0 or length > 1_000_000:
                return self._json(400, {'error': 'bad body'})
            data = json.loads(self.rfile.read(length).decode('utf-8'))
            text = str(data.get('text') or '').strip()
            if not text:
                return self._json(400, {'error': 'empty text'})
            wav = synth(text, data.get('voice') or 'aidar')
            self.send_response(200)
            self.send_header('Content-Type', 'audio/wav')
            self.send_header('Content-Length', str(len(wav)))
            self.end_headers()
            self.wfile.write(wav)
        except Exception as e:
            self._json(500, {'error': str(e)[:300]})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8765)
    ap.add_argument('--host', default='127.0.0.1')
    args = ap.parse_args()
    print(f'Silero TTS: http://{args.host}:{args.port} (загрузка модели...)', flush=True)
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == '__main__':
    main()
