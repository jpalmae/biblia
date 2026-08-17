"""Orquestador: descarga la liturgia del día desde eucaristiadiaria.cl y
el comentario/homilía desde evangeli.net, y los guarda en `data/YYYY-MM-DD.json`.

Uso:
    python -m scraper.main              # hoy
    python -m scraper.main 2026-08-12   # fecha específica
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import traceback
from datetime import date, datetime, timezone
from pathlib import Path

from . import eucaristia, evangeli

log = logging.getLogger("biblia")

DATA_DIR = Path(__file__).resolve().parent.parent / "data"


def _scrape_safe(name: str, fn, fecha: date | None) -> dict | None:
    """Ejecuta un scraper sin propagar excepciones: si falla, registra el error
    y devuelve None para que el otro fuente aún se guarde."""
    try:
        log.info("Scraping %s …", name)
        data = fn(fecha)
        log.info("OK %s (%d bytes)", name, len(json.dumps(data, ensure_ascii=False)))
        return data
    except Exception as exc:  # noqa: BLE001
        log.error("Fallo %s: %s", name, exc)
        log.debug("%s", traceback.format_exc())
        return {"error": str(exc), "traceback": traceback.format_exc()}


def run(fecha: date | None = None, out_dir: Path = DATA_DIR) -> Path:
    hoy = date.today()
    fecha = fecha or hoy
    # Si la fecha pedida es hoy, pasamos None para que cada scraper use su
    # URL "por defecto" (más confiable que la variante con parámetros de fecha).
    fecha_scrape = None if fecha == hoy else fecha
    out_dir.mkdir(parents=True, exist_ok=True)

    payload = {
        "fecha": fecha.isoformat(),
        "eucaristia_diaria": _scrape_safe(
            "eucaristiadiaria.cl", eucaristia.fetch, fecha_scrape
        ),
        "evangeli_net": _scrape_safe(
            "evangeli.net", evangeli.fetch, fecha_scrape
        ),
        "metadata": {
            "scraped_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "fuentes": ["eucaristiadiaria.cl", "evangeli.net"],
        },
    }

    out_file = out_dir / f"{fecha.isoformat()}.json"
    out_file.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    log.info("Guardado %s", out_file)
    return out_file


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Scraper diario de liturgia católica.")
    parser.add_argument(
        "fecha",
        nargs="?",
        help="Fecha ISO (YYYY-MM-DD). Por defecto: hoy.",
    )
    parser.add_argument(
        "-v", "--verbose",
        action="store_true",
        help="Logging detallado (incluye trazas de errores).",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )

    fecha = date.fromisoformat(args.fecha) if args.fecha else None
    out = run(fecha)
    print(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
