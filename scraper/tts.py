"""Sintetiza texto a MP3 usando edge-tts (Microsoft Edge Read Aloud, gratis,
sin API key). Por defecto usa la voz masculina chilena 'Lorenzo' (es-CL-LorenzoNeural).

Uso:
    echo "Hola mundo" | python -m scraper.tts --out salida.mp3
    python -m scraper.tts --out salida.mp3 --text "Hola mundo"
"""

from __future__ import annotations

import argparse
import asyncio
import subprocess
import sys
from pathlib import Path

import edge_tts

DEFAULT_VOICE = "es-CL-LorenzoNeural"


async def generate(text: str, output: str | Path, voice: str = DEFAULT_VOICE) -> None:
    communicate = edge_tts.Communicate(text, voice)
    await communicate.save(str(output))


def main() -> int:
    parser = argparse.ArgumentParser(description="TTS con edge-tts (voz Lorenzo CL).")
    parser.add_argument(
        "--text",
        help="Texto a sintetizar. Si se omite, se lee de stdin.",
    )
    parser.add_argument(
        "--out",
        required=True,
        help="Ruta del MP3 de salida.",
    )
    parser.add_argument(
        "--voice",
        default=DEFAULT_VOICE,
        help=f"Voz de edge-tts (default: {DEFAULT_VOICE}).",
    )
    parser.add_argument(
        "--rate",
        default="+0%",
        help="Velocidad de lectura, p.ej. '-10%%' más lento, '+10%%' más rápido.",
    )
    args = parser.parse_args()

    text = args.text if args.text is not None else sys.stdin.read()
    if not text.strip():
        print("Error: texto vacío.", file=sys.stderr)
        return 1

    async def run() -> None:
        communicate = edge_tts.Communicate(text, args.voice, rate=args.rate)
        await communicate.save(args.out)

    asyncio.run(run())

    # WhatsApp requiere Opus/OGG para que las notas de voz se reproduzcan
    # de forma confiable; el MP3 como voice note suele no entregarse.
    ogg = str(Path(args.out).with_suffix(".ogg"))
    conv = subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", args.out,
         "-ar", "48000", "-ac", "1", "-c:a", "libopus", ogg],
        capture_output=True, text=True,
    )
    if conv.returncode == 0 and Path(ogg).exists():
        Path(args.out).unlink(missing_ok=True)  # el mp3 ya no hace falta
        print(ogg)
    else:
        print(f"aviso: ffmpeg fallo, se usa mp3: {conv.stderr}", file=sys.stderr)
        print(args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
