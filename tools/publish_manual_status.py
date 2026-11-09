#!/usr/bin/env python3
"""Publica el resumen del último chequeo del manual en Firestore (manual_status/latest).

El panel de administración lo lee para mostrar el estado y avisar si el
vigilante semanal ha dejado de ejecutarse. Solo escribe si hay credenciales:

  FIREBASE_SERVICE_ACCOUNT   contenido JSON de la cuenta de servicio (secreto de GitHub)

Sin la variable no hace nada y sale sin error.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def build_summary(report: dict) -> dict:
    diff = report.get("diff") or {}
    manual = report.get("manual") or {}
    return {
        "status": report["status"],
        "checked_at": report["checked_at"],
        "new_manual": bool(report.get("new_manual")),
        "error": report.get("error"),
        "manual_edition": manual.get("edition"),
        "manual_url": manual.get("url"),
        "manual_last_modified": manual.get("last_modified"),
        "bank_source": report["bank"]["source"],
        "counts": {
            "answer_changed": len(diff.get("answer_changed", [])),
            "replaced": len(diff.get("replaced", [])),
            "text_edited": len(diff.get("text_edited", [])),
            "options_edited": len(diff.get("options_edited", [])),
            "added": len(diff.get("added", [])),
            "removed": len(diff.get("removed", [])),
            "unchanged": diff.get("unchanged", 0),
        },
        "answer_changed_ids": [item["id"] for item in diff.get("answer_changed", [])],
        "replaced_ids": [item["id"] for item in diff.get("replaced", [])],
    }


def main() -> int:
    credentials = os.environ.get("FIREBASE_SERVICE_ACCOUNT")
    if not credentials:
        print("::warning::Sin FIREBASE_SERVICE_ACCOUNT: no se publica el estado en Firestore.")
        return 0

    import firebase_admin
    from firebase_admin import credentials as fb_credentials
    from firebase_admin import firestore

    report_dir = Path(os.environ.get("REPORT_DIR", ROOT / "manual-report"))
    report_file = report_dir / "report.json"
    if not report_file.exists():
        print("::warning::No hay informe que publicar.")
        return 0
    report = json.loads(report_file.read_text(encoding="utf-8"))

    firebase_admin.initialize_app(fb_credentials.Certificate(json.loads(credentials)))
    summary = build_summary(report)
    summary["published_at"] = firestore.SERVER_TIMESTAMP
    firestore.client().collection("manual_status").document("latest").set(summary)
    print(f"Estado publicado en manual_status/latest: {summary['status']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
