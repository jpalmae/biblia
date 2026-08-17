"""Scraper para https://www.eucaristiadiaria.cl (Área de Liturgia y Espiritualidad,
Arzobispado de Santiago, Chile). Extrae la liturgia completa del día."""

from __future__ import annotations

from datetime import date

import requests
from bs4 import BeautifulSoup

BASE_URL = "https://www.eucaristiadiaria.cl"
USER_AGENT = (
    "Mozilla/5.0 (compatible; biblia-scraper/1.0; "
    "+https://github.com/jpalmae/biblia)"
)
TIMEOUT = 30


def _build_url(fecha: date | None) -> str:
    """`dia.php` siempre devuelve la liturgia de hoy.
    El sitio no expone las liturgias de días pasados por URL directa
    (`calendario.php` es solo la navegación), por lo que limitamos a hoy."""
    if fecha is not None and fecha != date.today():
        raise NotImplementedError(
            "eucaristiadiaria.cl solo permite scrapear la liturgia de hoy; "
            "no expone días pasados por URL directa."
        )
    return f"{BASE_URL}/dia.php"


def _clean_text(html) -> str:
    """Convierte un nodo HTML en texto plano limpio.
    - Desenvuelve los <span style="color:..."> (solo formato).
    - Conserva los párrafos separados por doble salto de línea.
    """
    for span in html.find_all("span"):
        span.unwrap()
    for a in html.find_all("a"):
        # Conservamos el texto del anchor pero no el link.
        a.unwrap()
    texto = html.get_text(separator="\n")
    # Normalizar espacios y líneas vacías.
    lineas = [line.strip() for line in texto.splitlines()]
    lineas = [l for l in lineas if l]
    return "\n\n".join(lineas)


def fetch(fecha: date | None = None) -> dict:
    """Descarga y parsea la liturgia del día.
    Devuelve un dict con `titulo` y `secciones` (lista de {nombre, contenido}).
    """
    url = _build_url(fecha)
    resp = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=TIMEOUT)
    resp.raise_for_status()
    resp.encoding = "utf-8"

    soup = BeautifulSoup(resp.text, "lxml")

    titulo_node = soup.select_one("div.titulos")
    titulo = titulo_node.get_text(" ", strip=True) if titulo_node else ""
    # Quitar la basura de los botones "+ A / - A" de tamaño de letra.
    for suf in ("+ A", "- A"):
        titulo = titulo.replace(suf, "").strip()

    secciones: list[dict] = []
    # Usamos `div.subtitulos` (no `.subtitulos`) para no capturar también
    # los <a class="subtitulos"> anidados, que duplicarían cada sección.
    vistos: set[str] = set()
    for sub in soup.select("div.subtitulos"):
        nombre = sub.get_text(strip=True)
        if not nombre or nombre in vistos:
            continue
        # Buscar el siguiente `.cuerpoNoticia` después de este subtítulo.
        cuerpo = None
        for sibling in sub.next_siblings:
            if hasattr(sibling, "select"):
                if sibling.select(".cuerpoNoticia"):
                    cuerpo = sibling.select_one(".cuerpoNoticia")
                    break
                if sibling.get("class") and "cuerpoNoticia" in sibling.get("class"):
                    cuerpo = sibling
                    break
        if cuerpo is None:
            # Búsqueda global como respaldo.
            cuerpo = sub.find_next_sibling(class_="cuerpoNoticia")
        contenido = _clean_text(cuerpo) if cuerpo else ""
        vistos.add(nombre)
        secciones.append({"nombre": nombre, "contenido": contenido})

    return {
        "url": url,
        "titulo": titulo,
        "secciones": secciones,
    }


if __name__ == "__main__":
    import json
    import sys

    fecha_arg = sys.argv[1] if len(sys.argv) > 1 else None
    f = date.fromisoformat(fecha_arg) if fecha_arg else None
    print(json.dumps(fetch(f), ensure_ascii=False, indent=2))
