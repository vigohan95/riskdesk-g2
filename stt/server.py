"""RiskDesk speech-to-text: a tiny local HTTP service around faster-whisper.

    POST /transcribe?lang=zh|en   body: raw PCM, 16 kHz, signed 16-bit little-endian, mono
                                  (exactly what the G2 microphone sends, 3200 bytes per 100 ms)
    -> {"text": "...", "lang": "zh", "model": "small", "audio_s": 2.4, "stt_ms": 1180}
    GET  /health                  -> {"ok": true, "loaded": ["base"]}

Audio never leaves the machine and no key is needed. Model choice was measured before the hackathon on
108 TTS trading commands (see ../README.md, "Voice"): Chinese uses `small` (base mishears too many
Chinese digits), English uses `base` (as accurate as small on these commands and ~3x faster).
Both get a short domain prompt so coin names and order words come back spelled the way the parser expects.

Run:  python -m pip install -r requirements.txt  &&  python server.py   (STT_HOST / STT_PORT to change)
"""

import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import numpy as np
from faster_whisper import WhisperModel

HOST = os.environ.get("STT_HOST", "127.0.0.1")
PORT = int(os.environ.get("STT_PORT", "8788"))
MODELS = {"zh": os.environ.get("STT_MODEL_ZH", "small"), "en": os.environ.get("STT_MODEL_EN", "base")}
PROMPTS = {
    "zh": "以下是简体中文的交易指令：比特币、以太坊、BTC、ETH、止损、止盈、减半、平仓、撤单、挂单、提醒。",
    "en": "Trading commands: BTC, ETH, Bitcoin, stop loss, take profit, cancel all orders, alert me.",
}
MAX_SECONDS = 20  # a spoken command is 1-5 s; anything longer is a stuck button
MIN_SECONDS = 0.3

_models: dict[str, WhisperModel] = {}
_lock = threading.Lock()  # one transcription at a time: CPU bound, and the glasses send one command at a time


def model_for(name: str) -> WhisperModel:
    if name not in _models:
        _models[name] = WhisperModel(name, device="cpu", compute_type="int8")
    return _models[name]


def transcribe(pcm: bytes, lang: str) -> dict:
    audio = np.frombuffer(pcm[: len(pcm) - len(pcm) % 2], dtype="<i2").astype(np.float32) / 32768.0
    name = MODELS[lang]
    t0 = time.time()
    with _lock:
        segs, _ = model_for(name).transcribe(
            audio, language=lang, beam_size=1, vad_filter=False, initial_prompt=PROMPTS[lang]
        )
        text = "".join(s.text for s in segs).strip()
    return {"text": text, "lang": lang, "model": name, "audio_s": round(len(audio) / 16000, 2),
            "stt_ms": round((time.time() - t0) * 1000)}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, body: dict) -> None:
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        if urlparse(self.path).path == "/health":
            self._send(200, {"ok": True, "loaded": sorted(_models)})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self) -> None:
        url = urlparse(self.path)
        if url.path != "/transcribe":
            return self._send(404, {"error": "not found"})
        lang = parse_qs(url.query).get("lang", ["en"])[0]
        if lang not in MODELS:
            return self._send(400, {"error": "lang must be zh or en"})
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_SECONDS * 32000:
            return self._send(413, {"error": f"audio longer than {MAX_SECONDS} s"})
        pcm = self.rfile.read(n)
        if len(pcm) < MIN_SECONDS * 32000:
            return self._send(400, {"error": "audio too short"})
        try:
            self._send(200, transcribe(pcm, lang))
        except Exception as e:  # report, never crash the service
            self._send(500, {"error": str(e)})

    def log_message(self, fmt: str, *args) -> None:
        print(f"stt {self.address_string()} {fmt % args}", flush=True)


if __name__ == "__main__":
    for name in sorted(set(MODELS.values())):  # load at start so the first command is not slow
        t = time.time()
        model_for(name)
        print(f"loaded {name} in {time.time() - t:.1f}s", flush=True)
    print(f"riskdesk stt on http://{HOST}:{PORT}  zh={MODELS['zh']} en={MODELS['en']}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
