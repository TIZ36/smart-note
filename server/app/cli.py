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
        ai_delegate = bool(getattr(args, "ai_delegate", False))
        result = ingest_raw(args.raw, args.note, reset=args.reset, ai_delegate=ai_delegate)
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


def cmd_special_ingest(args: argparse.Namespace) -> None:
    try:
        path = args.folder or args.file
        if not path:
            print(json.dumps({"inserted": 0, "files": 0, "message": "Provide --folder or --file"}, ensure_ascii=False))
            import sys; sys.exit(1)

        ai_delegate = bool(getattr(args, "ai_delegate", False))
        # Single PDF file
        if args.file and args.file.lower().endswith(".pdf"):
            from app.special_ingest import ingest_pdf
            result = ingest_pdf(args.file, topic_name=args.topic, ai_delegate=ai_delegate)
        # Folder
        else:
            from app.special_ingest import ingest_folder
            result = ingest_folder(path, topic_name=args.topic, ai_delegate=ai_delegate)

        print(json.dumps(result, ensure_ascii=False, indent=2))
    except Exception as e:
        print(json.dumps({"inserted": 0, "files": 0, "message": f"Special ingest failed: {e}"}, ensure_ascii=False))
        import sys
        sys.exit(1)


def cmd_mcp_import(args: argparse.Namespace) -> None:
    from app.mcp_import import import_mcp_doc
    try:
        result = import_mcp_doc(
            server_name=args.server,
            doc_url=args.url or "",
            document_id=args.doc_id or "",
            topic_name=args.topic or "",
            ai_delegate=bool(getattr(args, "ai_delegate", False)),
        )
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except Exception as e:
        print(json.dumps({"inserted": 0, "files": 0, "message": f"MCP import failed: {e}"}, ensure_ascii=False))
        import sys
        sys.exit(1)


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
    s.add_argument(
        "--ai-delegate",
        action="store_true",
        help="Skip backend ai_enrich and park the build awaiting MCP-caller enrichment",
    )
    s.set_defaults(func=cmd_ingest)

    s = sub.add_parser("search")
    s.add_argument("--query", required=True)
    s.add_argument("--topk", type=int, default=5)
    s.set_defaults(func=cmd_search)

    s = sub.add_parser("rebuild-memory")
    s.set_defaults(func=cmd_rebuild_memory)

    s = sub.add_parser("special-ingest")
    s.add_argument("--folder", default=None, help="Path to folder to ingest")
    s.add_argument("--file", default=None, help="Path to single file (e.g. PDF) to ingest")
    s.add_argument("--topic", default=None, help="Custom topic name (defaults to folder/file name)")
    s.add_argument(
        "--ai-delegate",
        action="store_true",
        help="Skip backend ai_enrich; park as awaiting_enrich for an MCP caller",
    )
    s.set_defaults(func=cmd_special_ingest)

    s = sub.add_parser("mcp-import")
    s.add_argument("--server", required=True, help="MCP server name")
    s.add_argument("--url", default=None, help="Document URL (e.g. Feishu wiki link)")
    s.add_argument("--doc-id", default=None, help="Document ID (alternative to URL)")
    s.add_argument("--topic", default=None, help="Custom topic name")
    s.add_argument(
        "--ai-delegate",
        action="store_true",
        help="Park raw content; let an MCP caller (Claude) rewrite to markdown",
    )
    s.set_defaults(func=cmd_mcp_import)

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
