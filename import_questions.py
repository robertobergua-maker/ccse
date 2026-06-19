#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import uuid
from typing import Any, Dict, List

try:
    import firebase_admin
    from firebase_admin import credentials, firestore
except ModuleNotFoundError:
    firebase_admin = None
    credentials = None
    firestore = None


def normalize_doc_id(text: str, max_len: int = 80) -> str:
    text = text or ''
    text = text.strip()
    text = re.sub(r"[^0-9a-zA-Z]+", "_", text)
    text = re.sub(r"_+", "_", text)
    text = text.strip("_")
    if not text:
        return str(uuid.uuid4())
    return text[:max_len]


def load_questions(json_path: str) -> List[Dict[str, Any]]:
    if not os.path.exists(json_path):
        raise FileNotFoundError(f"JSON file not found: {json_path}")
    with open(json_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, list):
        raise ValueError("JSON file must contain a top-level list of question objects.")
    if len(data) != 300:
        raise ValueError(f"Expected exactly 300 official questions; found {len(data)}.")

    seen_ids = set()
    task_counts = {1: 0, 2: 0, 3: 0, 4: 0, 5: 0}
    for index, question in enumerate(data, start=1):
        question_id = str(question.get("id", "")).strip()
        options = question.get("options")
        required = ("id", "question_text", "options", "correct_answer", "task_number")
        missing = [field for field in required if question.get(field) in (None, "", [])]
        if missing:
            raise ValueError(f"Question {index} is missing required fields: {missing}")
        if question_id in seen_ids:
            raise ValueError(f"Duplicate question ID: {question_id}")
        seen_ids.add(question_id)
        if not isinstance(options, list) or len(options) not in (2, 3):
            raise ValueError(f"{question_id}: options must contain 2 or 3 items.")
        option_keys = {option.get("key") for option in options}
        if question["correct_answer"] not in option_keys:
            raise ValueError(f"{question_id}: correct_answer is not present in options.")
        task = question["task_number"]
        if task not in task_counts:
            raise ValueError(f"{question_id}: invalid task_number {task}.")
        task_counts[task] += 1

    expected_counts = {1: 120, 2: 36, 3: 24, 4: 36, 5: 84}
    if task_counts != expected_counts:
        raise ValueError(
            f"Invalid task distribution: {task_counts}; expected {expected_counts}."
        )
    return data


def init_firestore(credentials_path: str) -> firestore.Client:
    if firebase_admin is None:
        raise RuntimeError(
            "firebase-admin is required for uploads. Install it with: "
            "python -m pip install firebase-admin"
        )
    if not os.path.exists(credentials_path):
        raise FileNotFoundError(f"Credentials file not found: {credentials_path}")
    cred = credentials.Certificate(credentials_path)
    if not firebase_admin._apps:
        firebase_admin.initialize_app(cred)
    return firestore.client()


def build_doc_id(question: Dict[str, Any], used_ids: set) -> str:
    if "id" in question and question["id"] not in (None, ""):
        candidate = str(question["id"]).strip()
    else:
        candidate = normalize_doc_id(question.get("question_text") or question.get("pregunta") or question.get("text") or "")
    if not candidate:
        candidate = str(uuid.uuid4())
    base = candidate
    suffix = 1
    while candidate in used_ids:
        candidate = f"{base}_{suffix}"
        suffix += 1
    used_ids.add(candidate)
    return candidate


def build_question_doc(question: Dict[str, Any], source_file: str) -> Dict[str, Any]:
    doc = question.copy()
    doc["source_file"] = os.path.basename(source_file)
    doc["imported_at"] = (
        firestore.SERVER_TIMESTAMP if firestore is not None else "SERVER_TIMESTAMP"
    )
    if "active" not in doc:
        doc["active"] = True
    return doc


def upload_questions(
    json_path: str,
    credentials_path: str,
    collection_name: str,
    batch_size: int,
    dry_run: bool,
) -> None:
    questions = load_questions(json_path)
    print(f"Loaded {len(questions)} questions from {json_path}")

    if dry_run:
        print("Dry run enabled. No documents will be written to Firestore.")

    firestore_client = None
    if not dry_run:
        firestore_client = init_firestore(credentials_path)
        print(f"Initialized Firestore using {credentials_path}")

    docs_to_write = []
    seen_ids = set()
    for index, question in enumerate(questions, start=1):
        doc_id = build_doc_id(question, seen_ids)
        docs_to_write.append((doc_id, build_question_doc(question, json_path)))

    print(f"Prepared {len(docs_to_write)} document IDs")
    if dry_run:
        for doc_id, doc in docs_to_write[:10]:
            print(f"  {doc_id}: {doc.get('question_text') or doc.get('pregunta')}")
        if len(docs_to_write) > 10:
            print(f"  ... plus {len(docs_to_write)-10} more")
        return

    batch = firestore_client.batch()
    collection_ref = firestore_client.collection(collection_name)
    for idx, (doc_id, doc_data) in enumerate(docs_to_write, start=1):
        doc_ref = collection_ref.document(doc_id)
        batch.set(doc_ref, doc_data, merge=True)
        if idx % batch_size == 0:
            print(f"Committing batch of {batch_size} documents...")
            batch.commit()
            batch = firestore_client.batch()
    if len(docs_to_write) % batch_size != 0:
        print(f"Committing final batch of {len(docs_to_write) % batch_size} documents...")
        batch.commit()

    print(f"Successfully uploaded {len(docs_to_write)} questions to Firestore collection '{collection_name}'.")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Import questions from JSON into Firestore.")
    parser.add_argument(
        "--json",
        default="preguntas.json",
        help="Path to the question JSON file. Defaults to preguntas.json.",
    )
    parser.add_argument(
        "--credentials",
        default="gcp-creds.json",
        help="Path to the Firebase service account JSON file.",
    )
    parser.add_argument(
        "--collection",
        default="questions",
        help="Firestore collection name to write question documents into.",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=250,
        help="Number of documents to write per Firestore batch commit.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Parse the JSON and prepare documents without writing to Firestore.",
    )
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    try:
        upload_questions(
            json_path=args.json,
            credentials_path=args.credentials,
            collection_name=args.collection,
            batch_size=args.batch_size,
            dry_run=args.dry_run,
        )
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
