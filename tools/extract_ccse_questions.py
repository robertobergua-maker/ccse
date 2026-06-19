#!/usr/bin/env python3
"""Extrae y valida las 300 preguntas del Manual CCSE 2025."""

import argparse
import json
import re
from pathlib import Path

import pdfplumber


PAGE_RANGES = {
    1: (16, 28),
    2: (34, 38),
    3: (44, 48),
    4: (60, 64),
    5: (82, 92),
}

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
    value = re.sub(
        r"(?i)\b([abc])\)\s+\1\)\s+",
        lambda match: f"{match.group(1).lower()}) ",
        value,
    )
    return value


def extract_answers(pdf) -> dict[str, str]:
    text = "\n".join(
        pdf.pages[index].extract_text(x_tolerance=2, y_tolerance=3) or ""
        for index in range(92, 101)
    )
    answers = dict(re.findall(r"\b([1-5]\d{3})\s+([abc])\b", text, re.I))
    return {code: answer.lower() for code, answer in answers.items()}


def extract_task_questions(pdf, task_number: int) -> list[dict]:
    start, end = PAGE_RANGES[task_number]
    raw = "\n".join(
        pdf.pages[index].extract_text(x_tolerance=2, y_tolerance=3) or ""
        for index in range(start, end)
    )
    raw = re.sub(r"(?m)^PREGUNTAS PARA LA TAREA \d\s*$", "", raw)
    raw = re.sub(r"(?m)^\d{1,3}\s*$", "", raw)

    markers = list(re.finditer(r"(?m)^([1-5]\d{3})\s+", raw))
    questions = []

    for index, marker in enumerate(markers):
        code = marker.group(1)
        block_end = markers[index + 1].start() if index + 1 < len(markers) else len(raw)
        block = clean_text(raw[marker.end() : block_end])
        labels = list(re.finditer(r"(?i)(?<!\w)([abc])\)\s*", block))
        expected_options = 2 if task_number == 2 else 3

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
                "source": "Manual CCSE 2025",
            }
        )

    return questions


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

    with pdfplumber.open(args.manual) as pdf:
        answers = extract_answers(pdf)
        questions = [
            question
            for task_number in PAGE_RANGES
            for question in extract_task_questions(pdf, task_number)
        ]

    for question in questions:
        try:
            question["correct_answer"] = answers[question["id"]]
        except KeyError as exc:
            raise ValueError(f"Falta la solución de {question['id']}") from exc

    validate_questions(questions)
    args.output.write_text(
        json.dumps(questions, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(
        f"OK: {len(questions)} preguntas escritas en {args.output} "
        f"con distribución {EXPECTED_COUNTS}"
    )


if __name__ == "__main__":
    main()
