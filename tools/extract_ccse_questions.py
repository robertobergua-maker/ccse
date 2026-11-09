#!/usr/bin/env python3
"""Extrae y valida las 300 preguntas del Manual CCSE (cualquier edición).

Las páginas se detectan automáticamente: no dependen de la maquetación de un
año concreto.
"""

import argparse
from collections import Counter
import json
import re
from pathlib import Path

import pdfplumber


TASK_TOPICS = {
    1: "Gobierno, legislación y participación ciudadana",
    2: "Derechos y deberes fundamentales",
    3: "Organización territorial de España. Geografía física y política",
    4: "Cultura e historia de España",
    5: "Sociedad española",
}

EXPECTED_COUNTS = {1: 120, 2: 36, 3: 24, 4: 36, 5: 84}


def clean_text(value: str) -> str:
    value = re.sub(r"\s+", " ", value).strip()
    # Pie de página que a veces se cuela en la última opción de una página.
    value = re.sub(r"\s*\b(?:SENOICULOS|SATNUGERP)\b", "", value).strip()
    value = re.sub(r"\s+\d{1,3}\s+Instituto Cervantes$", "", value).strip()
    value = re.sub(
        r"(?i)\b([abc])\)\s+\1\)\s+",
        lambda match: f"{match.group(1).lower()}) ",
        value,
    )
    return value


SOLUTION_PAIR_RE = re.compile(r"\b([1-5]\d{3})[ \t]+([abc])\b", re.I)
HEADER_LINE_RE = re.compile(
    r"(?im)^(manual de preparaci[oó]n de la prueba ccse.*|tarea \d\b.*|instituto cervantes|satnugerp|\d{1,3})\s*$"
)
CODE_LINE_RE = re.compile(r"(?m)^([1-5]\d{3})\s+")


CODE_WORD_RE = re.compile(r"^[1-5]\d{3}$")


def _extract(page) -> str:
    return page.extract_text(x_tolerance=2, y_tolerance=3) or ""


def page_text(page) -> str:
    """Texto de una página; si tiene dos columnas, primero la izquierda y luego la derecha.

    Se considera de dos columnas cuando algún código de pregunta (p. ej. 1016)
    empieza en la mitad derecha de la página.
    """
    # El pie de página («22 Instituto Cervantes») ocupa los últimos ~45 pt.
    page = page.crop((0, 0, page.width, page.height - 45))
    middle = page.width / 2
    words = page.extract_words(x_tolerance=2, y_tolerance=3)
    two_columns = any(
        CODE_WORD_RE.match(word["text"]) and word["x0"] > middle - 20
        for word in words
    )
    if not two_columns:
        return _extract(page)

    # La cabecera de la página cruza la mitad y dejaría fragmentos sueltos
    # en la columna derecha, así que se descarta la franja superior.
    top = 60
    left = page.crop((0, top, middle, page.height))
    right = page.crop((middle, top, page.width, page.height))
    return _extract(left) + "\n" + _extract(right)


def page_texts(pdf) -> list[str]:
    return [page_text(page) for page in pdf.pages]


def is_solution_page(text: str) -> bool:
    return len(SOLUTION_PAIR_RE.findall(text)) >= 20


def detect_edition(texts: list[str]) -> str:
    years = Counter(
        year for text in texts for year in re.findall(r"CCSE\)?\s+(20\d{2})", text)
    )
    return years.most_common(1)[0][0] if years else ""


def extract_answers(texts: list[str]) -> dict[str, str]:
    answers: dict[str, str] = {}
    for text in texts:
        if is_solution_page(text):
            for code, answer in SOLUTION_PAIR_RE.findall(text):
                task, number = int(code[0]), int(code[1:])
                if 1 <= number <= EXPECTED_COUNTS[task]:
                    answers.setdefault(code, answer.lower())
    return answers


def question_body(texts: list[str]) -> str:
    """Texto de las páginas de preguntas, sin cabeceras ni números de página."""
    parts = [
        HEADER_LINE_RE.sub("", text)
        for text in texts
        if not is_solution_page(text)
    ]
    # \f separa páginas: una pregunta normalmente no cruza de página.
    return "\n\f\n".join(parts)


def extract_task_questions(body: str, task_number: int) -> list[dict]:
    """Localiza las preguntas N001, N002… en orden correlativo.

    Aceptar solo el siguiente código esperado descarta años y otras cifras que
    empiezan una línea en el texto teórico (p. ej. «2015 se celebró…»).
    """
    expected_total = EXPECTED_COUNTS[task_number]
    markers = []
    next_number = 1
    for match in CODE_LINE_RE.finditer(body):
        if int(match.group(1)) != task_number * 1000 + next_number:
            continue
        markers.append(match)
        next_number += 1
        if next_number > expected_total:
            break

    questions = []
    for index, marker in enumerate(markers):
        code = marker.group(1)
        next_marker = markers[index + 1].start() if index + 1 < len(markers) else len(body)
        expected_options = 2 if task_number == 2 else 3

        # Primero se intenta acotar la pregunta al final de su página (así la
        # última pregunta de cada tarea no arrastra el texto que la sigue);
        # si no caben todas las opciones, la pregunta cruza de página.
        page_end = body.find("\f", marker.end())
        candidate_ends = [next_marker]
        if page_end != -1 and page_end < next_marker:
            candidate_ends.insert(0, page_end)

        for block_end in candidate_ends:
            block = clean_text(body[marker.end() : block_end])
            labels = list(re.finditer(r"(?i)(?<![\w.])([abc])(?:\)\s*|\.\s+)", block))
            if len(labels) == expected_options:
                break

        if len(labels) != expected_options:
            raise ValueError(
                f"{code}: se esperaban {expected_options} opciones y se detectaron {len(labels)}"
            )

        question_text = clean_text(block[: labels[0].start()])
        options = []
        for option_index, label in enumerate(labels):
            option_end = (
                labels[option_index + 1].start()
                if option_index + 1 < len(labels)
                else len(block)
            )
            options.append(
                {
                    "key": label.group(1).lower(),
                    "text": clean_text(block[label.end() : option_end]),
                }
            )

        questions.append(
            {
                "id": code,
                "code": code,
                "task_number": task_number,
                "topic": TASK_TOPICS[task_number],
                "question_text": question_text,
                "question_type": (
                    "true_false" if task_number == 2 else "multiple_choice"
                ),
                "options": options,
                "correct_answer": "",
                "active": True,
                "source": "Manual CCSE",
            }
        )

    return questions


def extract_manual(pdf_path: Path) -> tuple[list[dict], str]:
    """Devuelve (preguntas validadas, año de edición) de un PDF del manual."""
    with pdfplumber.open(pdf_path) as pdf:
        texts = page_texts(pdf)

    edition = detect_edition(texts)
    answers = extract_answers(texts)
    body = question_body(texts)
    questions = [
        question
        for task_number in EXPECTED_COUNTS
        for question in extract_task_questions(body, task_number)
    ]
    for question in questions:
        try:
            question["correct_answer"] = answers[question["id"]]
        except KeyError as exc:
            raise ValueError(f"Falta la solución de {question['id']}") from exc
        question["source"] = f"Manual CCSE {edition}".strip()

    validate_questions(questions)
    return questions, edition


def validate_questions(questions: list[dict]) -> None:
    if len(questions) != 300:
        raise ValueError(f"El banco debe contener 300 preguntas; contiene {len(questions)}")

    ids = [question["id"] for question in questions]
    if len(set(ids)) != len(ids):
        raise ValueError("Hay códigos de pregunta duplicados")

    counts = {
        task: sum(question["task_number"] == task for question in questions)
        for task in EXPECTED_COUNTS
    }
    if counts != EXPECTED_COUNTS:
        raise ValueError(f"Distribución incorrecta por tareas: {counts}")

    for question in questions:
        keys = {option["key"] for option in question["options"]}
        if not question["question_text"]:
            raise ValueError(f"{question['id']}: enunciado vacío")
        if question["correct_answer"] not in keys:
            raise ValueError(f"{question['id']}: respuesta correcta no disponible")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("manual", type=Path)
    parser.add_argument(
        "--output", type=Path, default=Path("preguntas.json")
    )
    args = parser.parse_args()

    questions, edition = extract_manual(args.manual)

    args.output.write_text(
        json.dumps(questions, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(
        f"OK: {len(questions)} preguntas escritas en {args.output} "
        f"con distribución {EXPECTED_COUNTS} (edición {edition or 'desconocida'})"
    )


if __name__ == "__main__":
    main()
