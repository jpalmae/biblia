"""Scraper para https://evangeli.net (sección española `/evangelio`).
Extrae el evangelio del día + comentario/homilía escrita por sacerdotes."""

from __future__ import annotations

from datetime import date

import re
import requests
from bs4 import BeautifulSoup

_WS = re.compile(r"\s+")


def _norm(text: str) -> str:
    """Colapsa secuencias de espacios en blanco (saltos de línea y tabs del
    HTML indentado) en un solo espacio."""
    return _WS.sub(" ", text).strip()

BASE_URL = "https://evangeli.net"
USER_AGENT = (
    "Mozilla/5.0 (compatible; biblia-scraper/1.0; "
    "+https://github.com/jpalmae/biblia)"
)
TIMEOUT = 30


def _build_url(fecha: date | None) -> str:
    if fecha is None:
        return f"{BASE_URL}/evangelio"
    # Ojo: la ruta por fecha usa "dia" en español y "day" en inglés.
    return f"{BASE_URL}/evangelio/dia/{fecha.isoformat()}"


def _text(node) -> str:
    """Texto corto en una sola línea (autor, refs, antífonas)."""
    if node is None:
        return ""
    return _norm(node.get_text(" ", strip=True))


def _text_block(node) -> str:
    """Texto largo que conserva separación de párrafos.
    Convierte `<br>` en saltos de línea y normaliza cada párrafo."""
    if node is None:
        return ""
    for br in node.find_all("br"):
        br.replace_with("\n")
    raw = node.get_text("\n")
    parrafos = [_norm(p) for p in raw.split("\n")]
    parrafos = [p for p in parrafos if p]
    return "\n\n".join(parrafos)


def fetch(fecha: date | None = None) -> dict:
    """Descarga y parsea el evangelio + comentario del día."""
    url = _build_url(fecha)
    resp = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=TIMEOUT)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "lxml")

    # Texto del evangelio: el <strong> tiene la referencia, el <span id="gospel_norm">
    # tiene el cuerpo. En español los IDs se mantienen.
    evangelio_ref = ""
    evangelio_texto = ""
    ev_node = soup.select_one(".evangeli_text")
    if ev_node:
        strong = ev_node.find("strong")
        if strong:
            evangelio_ref = _text(strong)
        span = ev_node.select_one("#gospel_norm")
        evangelio_texto = _text_block(span) or _text_block(ev_node)

    # Autor del comentario.
    autor = _text(soup.select_one(".autor_name"))
    autor_origen = _text(soup.select_one(".autor_origin"))

    # Comentario (la "homilía" escrita).
    comentario = _text_block(soup.select_one(".comentari_evangeli"))

    # Pensamientos / citas adicionales.
    pensamientos = [
        _text(p) for p in soup.select(".thoughts_text li p")
    ]

    # Primera lectura y salmo (también disponibles en evangeli.net).
    primera_lectura = _text_block(soup.select_one(".first_reading"))
    salmo_respuesta = _text(soup.select_one(".salm_response"))
    salmo_texto = _text_block(soup.select_one(".salm_text"))

    return {
        "url": url,
        "evangelio_ref": evangelio_ref,
        "evangelio_texto": evangelio_texto,
        "autor": autor,
        "autor_origen": autor_origen,
        "comentario": comentario,
        "pensamientos": pensamientos,
        "primera_lectura": primera_lectura,
        "salmo_respuesta": salmo_respuesta,
        "salmo_texto": salmo_texto,
    }


if __name__ == "__main__":
    import json
    import sys

    fecha_arg = sys.argv[1] if len(sys.argv) > 1 else None
    f = date.fromisoformat(fecha_arg) if fecha_arg else None
    print(json.dumps(fetch(f), ensure_ascii=False, indent=2))
