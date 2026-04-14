from __future__ import annotations

import argparse
import json

import uvicorn

from app.db import init_db, migrate_db
from app.ingest import ingest_raw
from app.memory import add_feedback
from app.retrieval import search


def cmd_init_db(_: argparse.Namespace) -> None:
    init_db()
    migrate_db()
    print("db initialized (with migrations)")


def cmd_ingest(args: argparse.Namespace) -> None:
    try:
        result = ingest_raw(args.raw, args.note, reset=args.reset)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except Exception as e:
        print(json.dumps({"inserted": 0, "total": 0, "tags": {}, "segments": 0, "message": f"Ingest failed: {e}"}, ensure_ascii=False))
        import sys
        sys.exit(1)


def cmd_search(args: argparse.Namespace) -> None:
    result = search(args.query, args.topk)
    print(json.dumps(result, ensure_ascii=False, indent=2))


def cmd_rebuild_memory(_: argparse.Namespace) -> None:
    print("Q&A memories are now auto-created on feedback. No manual rebuild needed.")


def cmd_serve(args: argparse.Namespace) -> None:
    uvicorn.run("app.gateway:app", host="127.0.0.1", port=args.port, reload=False)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Smart Notes MVP CLI")
    sub = p.add_subparsers(required=True)

    s = sub.add_parser("init-db")
    s.set_defaults(func=cmd_init_db)

    s = sub.add_parser("ingest")
    s.add_argument("--raw", required=True)
    s.add_argument("--note", required=True)
    s.add_argument(
        "--reset",
        action="store_true",
        help="Rebuild note/views/chunks for this raw file",
    )
    s.set_defaults(func=cmd_ingest)

    s = sub.add_parser("search")
    s.add_argument("--query", required=True)
    s.add_argument("--topk", type=int, default=5)
    s.set_defaults(func=cmd_search)

    s = sub.add_parser("rebuild-memory")
    s.set_defaults(func=cmd_rebuild_memory)

    s = sub.add_parser("serve")
    s.add_argument("--port", type=int, default=8787)
    s.set_defaults(func=cmd_serve)
    return p


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
