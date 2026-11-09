#!/usr/bin/env python3
"""Comprueba si preguntas.json está al día con el último Manual CCSE oficial.

1. Descubre el PDF vigente en las páginas del Instituto Cervantes (o usa --pdf/--url).
2. Lo descarga, calcula su huella (SHA-256) y extrae las 300 preguntas.
3. Compara con el banco de la app y clasifica las diferencias.
4. Escribe un informe (JSON + Markdown). No modifica nunca el banco.

Estado resultante:
  UP_TO_DATE  el banco coincide con el manual oficial
  OUTDATED    hay diferencias de contenido (ver el informe)
  ERROR       no se pudo descubrir/descargar/leer el manual (p. ej. cambió el formato)
"""

from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import re
import sys
import tempfile
import unicodedata
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin

sys.path.insert(0, str(Path(__file__).resolve().parent))

DISCOVERY_PAGES = [
    "https://examenes.cervantes.es/es/ccse/preparar-prueba",
    "https://cervantes.org/es/sobre-nosotros/publicaciones/manual-preparacion-prueba-conocimientos-constitucionales",
    "https://cervantes.org/es/examenes/ccse",
]
USER_AGENT = "Mozilla/5.0 (compatible; ccse-manual-watch/1.0)"
PDF_HREF_RE = re.compile(r"""href=["']([^"']+?\.pdf)(?:\?[^"']*)?["']""", re.I)

# Una pregunta cuyo enunciado se parece menos que esto se considera sustituida.
REPLACED_THRESHOLD = 0.6
# Por encima de esto el enunciado se considera «la misma pregunta».
SAME_QUESTION_THRESHOLD = 0.85
# Dos respuestas correctas tan parecidas se consideran la misma, redactada distinto.
REWORDED_THRESHOLD = 0.75


# ── Red ──────────────────────────────────────────────────────────────────────

def http_get(url: str, timeout: int = 60) -> tuple[bytes, dict[str, str]]:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        headers = {key.lower(): value for key, value in response.headers.items()}
        return response.read(), headers


def edition_from_url(url: str) -> int:
    years = re.findall(r"(20\d{2})", url.rsplit("/", 1)[-1])
    return int(years[-1]) if years else 0


def discover_manual_url() -> str:
    candidates: set[str] = set()
    errors = []
    for page in DISCOVERY_PAGES:
        try:
            html = http_get(page)[0].decode("utf-8", "replace")
        except Exception as exc:  # noqa: BLE001 - se informa y se sigue con otra página
            errors.append(f"{page}: {exc}")
            continue
        for href in PDF_HREF_RE.findall(html):
            url = urljoin(page, href)
            if re.search(r"ccse", url, re.I) and re.search(r"manual", url, re.I):
                candidates.add(url)

    if not candidates:
        raise RuntimeError(
            "No se encontró ningún PDF del manual CCSE en las páginas del Instituto Cervantes. "
            "Puede haber cambiado la web. " + " | ".join(errors)
        )
    # La edición más reciente; a igualdad, la ruta más reciente (carpeta AAAA-MM).
    return max(candidates, key=lambda url: (edition_from_url(url), url))


# ── Comparación ──────────────────────────────────────────────────────────────

def norm(value: str) -> str:
    """Normaliza para ignorar diferencias cosméticas (mayúsculas, tildes, puntuación)."""
    value = unicodedata.normalize("NFKD", str(value))
    value = "".join(ch for ch in value if not unicodedata.combining(ch))
    value = re.sub(r"[^\w\s]", " ", value.lower())
    return re.sub(r"\s+", " ", value).strip()


def similarity(left: str, right: str) -> float:
    return difflib.SequenceMatcher(None, norm(left), norm(right)).ratio()


def correct_text(question: dict) -> str:
    for option in question["options"]:
        if option["key"] == question["correct_answer"]:
            return option["text"]
    return ""


def summarize(question: dict) -> dict:
    return {
        "id": question["id"],
        "question": question["question_text"],
        "options": [f"{o['key']}) {o['text']}" for o in question["options"]],
        "correct": f"{question['correct_answer']}) {correct_text(question)}",
    }


def compare_banks(bank: list[dict], manual: list[dict]) -> dict:
    bank_by_id = {q["id"]: q for q in bank}
    manual_by_id = {q["id"]: q for q in manual}

    result = {
        "added": sorted(set(manual_by_id) - set(bank_by_id)),
        "removed": sorted(set(bank_by_id) - set(manual_by_id)),
        "replaced": [],        # pregunta distinta bajo el mismo código
        "answer_changed": [],  # misma pregunta, otra respuesta correcta (CRÍTICO)
        "text_edited": [],     # enunciado retocado
        "options_edited": [],  # opciones retocadas con la misma respuesta
        "cosmetic": 0,         # solo tildes/puntuación/mayúsculas (se ignora)
        "unchanged": 0,
    }

    for qid in sorted(set(bank_by_id) & set(manual_by_id), key=lambda x: int(x)):
        old, new = bank_by_id[qid], manual_by_id[qid]
        same_text = norm(old["question_text"]) == norm(new["question_text"])
        same_options = [norm(o["text"]) for o in old["options"]] == [norm(o["text"]) for o in new["options"]]
        same_correct = norm(correct_text(old)) == norm(correct_text(new))

        if same_text and same_options and same_correct:
            if old["question_text"] == new["question_text"] and old["options"] == new["options"] \
                    and old["correct_answer"] == new["correct_answer"]:
                result["unchanged"] += 1
            else:
                result["cosmetic"] += 1
            continue

        entry = {"id": qid, "before": summarize(old), "after": summarize(new)}
        text_ratio = similarity(old["question_text"], new["question_text"])
        if text_ratio < REPLACED_THRESHOLD:
            result["replaced"].append(entry)
        elif not same_correct:
            # Misma pregunta con otra respuesta: crítico salvo que solo cambie la
            # redacción («En referéndum» → «Por referéndum»). Si cambia alguna cifra
            # («48 millones» → «49 millones») siempre es crítico.
            old_correct, new_correct = correct_text(old), correct_text(new)
            digits_differ = re.findall(r"\d+", old_correct) != re.findall(r"\d+", new_correct)
            reworded = similarity(old_correct, new_correct) >= REWORDED_THRESHOLD
            if text_ratio < SAME_QUESTION_THRESHOLD and not reworded:
                result["replaced"].append(entry)
            elif reworded and not digits_differ:
                result["options_edited"].append(entry)
            else:
                result["answer_changed"].append(entry)
        elif not same_text:
            result["text_edited"].append(entry)
        else:
            result["options_edited"].append(entry)

    return result


def count_changes(diff: dict) -> int:
    return (
        len(diff["added"]) + len(diff["removed"]) + len(diff["replaced"])
        + len(diff["answer_changed"]) + len(diff["text_edited"]) + len(diff["options_edited"])
    )


# ── Informe ──────────────────────────────────────────────────────────────────

STATUS_LABEL = {
    "UP_TO_DATE": "✅ Al día",
    "OUTDATED": "⚠️ Banco desactualizado",
    "ERROR": "❌ Error en la comprobación",
}


def render_markdown(report: dict) -> str:
    lines = [
        f"# Estado del Manual CCSE — {report['checked_at'][:10]}",
        "",
        f"**Resultado:** {STATUS_LABEL[report['status']]}",
        "",
    ]
    if report.get("error"):
        lines += [f"**Error:** {report['error']}", ""]

    manual = report.get("manual") or {}
    bank = report["bank"]
    lines += [
        "## Fuentes",
        f"- Manual oficial: edición **{manual.get('edition') or '?'}** — {manual.get('url') or 'no disponible'}",
        f"  - Publicado/modificado: {manual.get('last_modified') or 'desconocido'}",
        f"  - SHA-256: `{(manual.get('sha256') or '—')[:16]}…`",
        f"- Banco de la app: **{bank['source']}** ({bank['count']} preguntas)",
    ]
    if report.get("new_manual"):
        lines.append(
            f"- 🆕 **Manual nuevo** respecto al último revisado "
            f"(edición revisada: {report['state'].get('edition') or '—'})."
        )
    lines.append("")

    diff = report.get("diff")
    if diff:
        lines += [
            "## Diferencias banco ↔ manual",
            f"- Respuesta correcta cambiada (crítico): **{len(diff['answer_changed'])}**",
            f"- Preguntas sustituidas por otra: **{len(diff['replaced'])}**",
            f"- Enunciados retocados: **{len(diff['text_edited'])}**",
            f"- Opciones retocadas (misma respuesta): **{len(diff['options_edited'])}**",
            f"- Códigos nuevos / eliminados: **{len(diff['added'])} / {len(diff['removed'])}**",
            f"- Cosméticas ignoradas (tildes, puntuación): {diff['cosmetic']}",
            f"- Sin cambios: {diff['unchanged']}",
            "",
        ]
        if diff["answer_changed"]:
            lines += ["## ⚠️ Respuestas correctas cambiadas", ""]
            for item in diff["answer_changed"][:40]:
                lines += [
                    f"- **{item['id']}** {item['after']['question']}",
                    f"  - App: {item['before']['correct']}",
                    f"  - Manual: {item['after']['correct']}",
                ]
            lines.append("")
        if diff["replaced"]:
            ids = ", ".join(item["id"] for item in diff["replaced"])
            lines += ["## Preguntas sustituidas", ids, ""]
        if diff["text_edited"]:
            lines += ["## Enunciados retocados (primeros 15)", ""]
            for item in diff["text_edited"][:15]:
                lines += [
                    f"- **{item['id']}**",
                    f"  - App: {item['before']['question']}",
                    f"  - Manual: {item['after']['question']}",
                ]
            lines.append("")

    lines += ["## Qué hacer", ""]
    if report["status"] == "UP_TO_DATE":
        lines.append("Nada: el banco coincide con el manual oficial.")
    elif report["status"] == "OUTDATED":
        lines += [
            "1. Descarga el manual y regenera: `python tools/extract_ccse_questions.py manual.pdf`.",
            "2. Revisa las respuestas cambiadas y las preguntas sustituidas "
            "(las `explicacion_facil` de estas últimas hay que regenerarlas).",
            "3. Sube el banco con `python import_questions.py` y, tras revisarlo, "
            "`python tools/check_ccse_manual.py --update-state`.",
        ]
    else:
        lines.append(
            "Revisa el error. Si Cervantes cambió la web o el formato del PDF, hay que adaptar "
            "`tools/check_ccse_manual.py` o `tools/extract_ccse_questions.py`."
        )
    return "\n".join(lines) + "\n"


# ── Ejecución ────────────────────────────────────────────────────────────────

def load_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def run(args: argparse.Namespace) -> dict:
    bank = load_json(args.bank, [])
    state = load_json(args.state, {})
    sources = sorted({q.get("source", "") for q in bank})
    report: dict = {
        "checked_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "status": "ERROR",
        "new_manual": False,
        "state": state,
        "bank": {"count": len(bank), "source": ", ".join(s for s in sources if s) or "desconocido"},
        "manual": None,
        "diff": None,
        "error": None,
    }

    try:
        with tempfile.TemporaryDirectory() as tmp:
            if args.pdf:
                pdf_path = args.pdf
                data = pdf_path.read_bytes()
                url, headers = str(pdf_path), {}
            else:
                url = args.url or discover_manual_url()
                data, headers = http_get(url, timeout=120)
                pdf_path = Path(tmp) / "manual.pdf"
                pdf_path.write_bytes(data)

            if not data.startswith(b"%PDF"):
                raise RuntimeError(f"La descarga de {url} no es un PDF")

            sha256 = hashlib.sha256(data).hexdigest()
            from extract_ccse_questions import extract_manual

            questions, edition = extract_manual(pdf_path)

        report["manual"] = {
            "url": url,
            "edition": edition,
            "sha256": sha256,
            "last_modified": headers.get("last-modified"),
            "etag": headers.get("etag"),
            "size": len(data),
        }
        report["new_manual"] = (
            state.get("sha256") != sha256 or str(state.get("edition")) != str(edition)
        )
        report["diff"] = compare_banks(bank, questions)
        report["status"] = "OUTDATED" if count_changes(report["diff"]) else "UP_TO_DATE"
    except Exception as exc:  # noqa: BLE001 - cualquier fallo debe quedar en el informe
        report["error"] = f"{type(exc).__name__}: {exc}"

    return report


def main() -> int:
    root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    parser.add_argument("--pdf", type=Path, help="usar un PDF local en lugar de descargarlo")
    parser.add_argument("--url", help="URL concreta del PDF (omite el descubrimiento)")
    parser.add_argument("--bank", type=Path, default=root / "preguntas.json")
    parser.add_argument("--state", type=Path, default=root / "tools" / "manual_state.json")
    parser.add_argument("--report-dir", type=Path, default=root / "manual-report")
    parser.add_argument("--update-state", action="store_true",
                        help="marca el manual actual como revisado (hacerlo tras actualizar el banco)")
    parser.add_argument("--fail-on-diff", action="store_true",
                        help="código de salida 1 si está desactualizado y 2 si hay error")
    args = parser.parse_args()

    report = run(args)
    args.report_dir.mkdir(parents=True, exist_ok=True)
    (args.report_dir / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    markdown = render_markdown(report)
    (args.report_dir / "report.md").write_text(markdown, encoding="utf-8")
    print(markdown)

    if args.update_state:
        if report["status"] == "ERROR" or not report["manual"]:
            print("No se actualiza el estado: la comprobación falló.", file=sys.stderr)
            return 2
        args.state.write_text(json.dumps({
            "edition": report["manual"]["edition"],
            "sha256": report["manual"]["sha256"],
            "url": report["manual"]["url"],
            "reviewed_at": report["checked_at"],
        }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"Estado guardado en {args.state}")

    if args.fail_on_diff:
        return {"UP_TO_DATE": 0, "OUTDATED": 1}.get(report["status"], 2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
