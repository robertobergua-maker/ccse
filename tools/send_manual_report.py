#!/usr/bin/env python3
"""Envía por correo el informe semanal del Manual CCSE (manual-report/report.json).

Configuración por variables de entorno (en GitHub: Settings → Secrets → Actions):
  SMTP_HOST      p. ej. smtp.gmail.com
  SMTP_PORT      465 (SSL, por defecto) o 587 (STARTTLS)
  SMTP_USER      usuario SMTP (en Gmail, la dirección completa)
  SMTP_PASSWORD  contraseña SMTP (en Gmail, una «contraseña de aplicación»)
  MAIL_TO        destinatario(s), separados por comas
  MAIL_FROM      remitente (opcional; por defecto SMTP_USER)

Si no hay ninguna variable definida no hace nada y sale sin error.
"""

from __future__ import annotations

import html
import json
import os
import smtplib
import ssl
import sys
from email.message import EmailMessage
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REQUIRED = ("SMTP_HOST", "SMTP_USER", "SMTP_PASSWORD", "MAIL_TO")

HEADLINE = {
    "UP_TO_DATE": "✅ Al día",
    "OUTDATED": "⚠️ Banco desactualizado",
    "ERROR": "❌ Error en la comprobación",
}


def build_subject(report: dict) -> str:
    manual = report.get("manual") or {}
    edition = manual.get("edition") or "?"
    subject = f"[CCSE] Manual {edition}: {HEADLINE[report['status']]}"
    diff = report.get("diff")
    if diff and diff["answer_changed"]:
        subject += f" — {len(diff['answer_changed'])} respuesta(s) cambiada(s)"
    if report.get("new_manual"):
        subject = "🆕 " + subject
    return subject


def build_html(report: dict, markdown: str) -> str:
    """HTML mínimo: el informe en Markdown dentro de un bloque legible."""
    color = {"UP_TO_DATE": "#166534", "OUTDATED": "#b45309", "ERROR": "#b91c1c"}[report["status"]]
    return (
        '<div style="font-family:Segoe UI,Arial,sans-serif;max-width:680px">'
        f'<h2 style="color:{color};margin:0 0 12px">{html.escape(HEADLINE[report["status"]])}</h2>'
        f'<pre style="white-space:pre-wrap;font-family:inherit;font-size:14px;line-height:1.5">'
        f"{html.escape(markdown)}</pre></div>"
    )


def main() -> int:
    present = [name for name in REQUIRED if os.environ.get(name)]
    if not present:
        print("::warning::Sin configuración SMTP: no se envía el correo semanal.")
        return 0
    missing = [name for name in REQUIRED if name not in present]
    if missing:
        print(f"::error::Faltan secretos SMTP: {', '.join(missing)}", file=sys.stderr)
        return 1

    report_dir = Path(os.environ.get("REPORT_DIR", ROOT / "manual-report"))
    try:
        report = json.loads((report_dir / "report.json").read_text(encoding="utf-8"))
        markdown = (report_dir / "report.md").read_text(encoding="utf-8")
    except FileNotFoundError:
        # El script de comprobación ni siquiera llegó a generar informe: se avisa igualmente.
        report = {"status": "ERROR", "manual": None, "diff": None}
        markdown = (
            "# Estado del Manual CCSE\n\n**Resultado:** ❌ Error en la comprobación\n\n"
            "El vigilante falló antes de generar el informe. Revisa la ejecución en la "
            "pestaña Actions de GitHub.\n"
        )

    sender = os.environ.get("MAIL_FROM") or os.environ["SMTP_USER"]
    recipients = [a.strip() for a in os.environ["MAIL_TO"].split(",") if a.strip()]

    message = EmailMessage()
    message["Subject"] = build_subject(report)
    message["From"] = sender
    message["To"] = ", ".join(recipients)
    message.set_content(markdown)
    message.add_alternative(build_html(report, markdown), subtype="html")

    host = os.environ["SMTP_HOST"]
    port = int(os.environ.get("SMTP_PORT") or 465)
    context = ssl.create_default_context()
    if port == 465:
        with smtplib.SMTP_SSL(host, port, context=context, timeout=60) as smtp:
            smtp.login(os.environ["SMTP_USER"], os.environ["SMTP_PASSWORD"])
            smtp.send_message(message)
    else:
        with smtplib.SMTP(host, port, timeout=60) as smtp:
            smtp.starttls(context=context)
            smtp.login(os.environ["SMTP_USER"], os.environ["SMTP_PASSWORD"])
            smtp.send_message(message)

    print(f"Correo enviado a {', '.join(recipients)}: {message['Subject']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
