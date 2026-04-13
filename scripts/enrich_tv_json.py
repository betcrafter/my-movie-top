#!/usr/bin/env python3
"""
Enrich a JSON list (tv.json, movies.json, …) with year, tmdb_id, kinopoisk_id, imdb_id
via poiskkino.dev search API.

Rows that already have kinopoisk_id, tmdb_id (>0) and imdb_id (non-empty "tt…" string)
are left unchanged except for normalizing JSON shape; no HTTP request is made for them.
imdb_id is stored as a string like "tt0411008" (as in the API externalId.imdb).

Reads a file under the project root (--input, default tv.json); the source file is not modified.
By default writes {stem}_YYYYMMDD_HHMMSS.json (e.g. movies_20260403_120000.json).

Requires API token in env (POISK_KINO_API_KEY) or in project-root .env — see --help.
Use -n N to cap how many search API calls are made per run (daily quota).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

API_BASE = "https://api.poiskkino.dev/v1.4/movie/search"
REQUEST_DELAY_SEC = 0.35
ENV_KEYS = ("POISK_KINO_API_KEY", "POISK_KINO_TOKEN", "X_API_KEY")


def repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def load_env_file(root: Path) -> None:
    """Set missing env vars from root/.env (KEY=value per line, no deps)."""
    path = root / ".env"
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        val = val.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = val


def default_timestamped_output_path(root: Path, file_stem: str) -> Path:
    """{file_stem}_YYYYMMDD_HHMMSS.json under root; if taken, add _2, _3, …"""
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    base = f"{file_stem}_{ts}.json"
    p = root / base
    if not p.exists():
        return p
    for n in range(2, 10_000):
        p = root / f"{file_stem}_{ts}_{n}.json"
        if not p.exists():
            return p
    raise RuntimeError(f"Could not find a free {file_stem}_<timestamp>.json filename")


def infer_mode_from_input_path(path: Path) -> str:
    """Guess tv vs movie from filename (movies.json -> movie, tv.json -> tv)."""
    stem = path.stem.lower()
    if stem == "tv" or stem.startswith("tv_"):
        return "tv"
    if "movie" in stem:
        return "movie"
    return "tv"


def resolve_under_root(root: Path, relative: str) -> Path | None:
    p = (root / relative.strip()).resolve()
    try:
        p.relative_to(root.resolve())
    except ValueError:
        return None
    return p


def api_key_from_env() -> str:
    for name in ENV_KEYS:
        v = os.environ.get(name, "").strip()
        if v:
            return v
    return ""


def as_positive_int(val: object) -> int | None:
    """Return int if value is a positive integer, else None."""
    if val is None:
        return None
    try:
        n = int(val)
    except (TypeError, ValueError):
        return None
    return n if n > 0 else None


def normalize_imdb_id(raw: object) -> str:
    """
    IMDb title id as string: "tt" + digits (min 7-digit body when converting from int).
    Empty string if missing / invalid. Preserves API form e.g. tt0411008.
    """
    if raw is None:
        return ""
    if isinstance(raw, (int, float)):
        if raw <= 0:
            return ""
        n = int(raw)
        body = str(n)
        if len(body) < 7:
            body = body.zfill(7)
        return "tt" + body
    s = str(raw).strip()
    if not s or s == "0":
        return ""
    low = s.lower()
    if low.startswith("tt") and len(low) > 2 and low[2:].isdigit():
        return "tt" + low[2:]
    try:
        n = int(s, 10)
    except ValueError:
        return ""
    if n <= 0:
        return ""
    body = str(n)
    if len(body) < 7:
        body = body.zfill(7)
    return "tt" + body


def entry_has_all_ids(entry: dict) -> bool:
    """True if kinopoisk, tmdb are >0 and imdb_id is a non-empty tt… string (no API needed)."""
    if as_positive_int(entry.get("kinopoisk_id")) is None:
        return False
    if as_positive_int(entry.get("tmdb_id")) is None:
        return False
    return bool(normalize_imdb_id(entry.get("imdb_id")))


def passthrough_row(entry: dict) -> dict:
    """Same shape as enrich_row output, using existing entry fields (IDs already complete)."""
    y = entry.get("year")
    year = y if isinstance(y, int) else 0
    return {
        "title": entry.get("title", ""),
        "rating": entry.get("rating"),
        "year": year,
        "tmdb_id": as_positive_int(entry.get("tmdb_id")) or 0,
        "kinopoisk_id": as_positive_int(entry.get("kinopoisk_id")) or 0,
        "imdb_id": normalize_imdb_id(entry.get("imdb_id")),
    }


def pick_doc(docs: list[dict], mode: str) -> dict | None:
    if not docs:
        return None
    if mode == "tv":
        tv = [
            d
            for d in docs
            if d.get("type") == "tv-series" or d.get("isSeries") is True
        ]
        if tv:
            return tv[0]
        print(
            f"Warning: no tv-series in results, using first doc: {docs[0].get('name', '?')!r}",
            file=sys.stderr,
        )
        return docs[0]

    # movie: prefer feature film, then cartoon; avoid tv-series when possible
    for d in docs:
        if d.get("type") == "movie":
            return d
    for d in docs:
        if d.get("type") == "cartoon":
            return d
    non_series = [
        d
        for d in docs
        if d.get("type") != "tv-series" and d.get("isSeries") is not True
    ]
    if non_series:
        return non_series[0]
    print(
        f"Warning: no non-series hit in results, using first doc: {docs[0].get('name', '?')!r}",
        file=sys.stderr,
    )
    return docs[0]


def search(api_key: str, query: str) -> tuple[list[dict], int | None]:
    """
    Returns (docs, http_status_on_error).
    http_status_on_error is None on success; on HTTP error returns ([], code).
    """
    params = {"page": 1, "limit": 10, "query": query}
    url = API_BASE + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(
        url,
        headers={
            "accept": "application/json",
            "X-API-KEY": api_key,
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            payload = json.load(resp)
    except urllib.error.HTTPError as e:
        try:
            body = e.read().decode("utf-8", errors="replace")[:800]
        except Exception:
            body = ""
        print(
            f"HTTP {e.code} for query={query!r}: {e.reason}"
            + (f"\n  Response: {body}" if body else ""),
            file=sys.stderr,
        )
        if e.code == 401:
            print(
                "  Hint: token invalid or missing. Set POISK_KINO_API_KEY or add it to .env in the repo root.",
                file=sys.stderr,
            )
        return [], e.code
    except urllib.error.URLError as e:
        print(f"Network error for query={query!r}: {e}", file=sys.stderr)
        return [], None
    except json.JSONDecodeError as e:
        print(f"Invalid JSON for query={query!r}: {e}", file=sys.stderr)
        return [], None

    docs = payload.get("docs")
    if not isinstance(docs, list):
        return [], None
    return docs, None


def build_query(entry: dict) -> str:
    title = (entry.get("title") or "").strip()
    y = entry.get("year")
    if isinstance(y, int) and y > 0:
        return f"{title} {y}"
    return title


def enrich_row(entry: dict, doc: dict | None) -> dict:
    title = entry.get("title", "")
    rating = entry.get("rating")

    if doc is None:
        year = entry.get("year") if isinstance(entry.get("year"), int) else 0
        return {
            "title": title,
            "rating": rating,
            "year": year,
            "tmdb_id": 0,
            "kinopoisk_id": 0,
            "imdb_id": normalize_imdb_id(entry.get("imdb_id")),
        }

    ext = doc.get("externalId") or {}
    if not isinstance(ext, dict):
        ext = {}

    tmdb = ext.get("tmdb")
    if tmdb is None:
        tmdb = 0
    try:
        tmdb = int(tmdb)
    except (TypeError, ValueError):
        tmdb = 0

    kp = doc.get("id")
    try:
        kinopoisk_id = int(kp) if kp is not None else 0
    except (TypeError, ValueError):
        kinopoisk_id = 0

    year = doc.get("year")
    if not isinstance(year, int):
        year = entry.get("year") if isinstance(entry.get("year"), int) else 0

    imdb_str = normalize_imdb_id(ext.get("imdb"))

    return {
        "title": title,
        "rating": rating,
        "year": year,
        "tmdb_id": tmdb,
        "kinopoisk_id": kinopoisk_id,
        "imdb_id": imdb_str,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Enrich tv.json / movies.json (etc.) via poiskkino.dev search API"
    )
    parser.add_argument(
        "-i",
        "--input",
        type=str,
        default="tv.json",
        metavar="FILE",
        help="Input JSON under project root (default: tv.json). Example: movies.json",
    )
    parser.add_argument(
        "--mode",
        choices=("auto", "tv", "movie"),
        default="auto",
        help="How to pick the best search hit: auto from filename, or force tv vs movie",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print enriched JSON to stdout only; no file is written",
    )
    parser.add_argument(
        "-o",
        "--output",
        type=str,
        default="",
        metavar="PATH",
        help="Output path under project root (default: {input_stem}_YYYYMMDD_HHMMSS.json)",
    )
    parser.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="Log each search query and hit count to stderr",
    )
    parser.add_argument(
        "-n",
        "--max-requests",
        type=int,
        default=None,
        metavar="N",
        help="Perform at most N search API requests this run (omit for no limit). "
        "Further rows keep existing fields (normalized), no new lookups.",
    )
    args = parser.parse_args()

    if args.max_requests is not None and args.max_requests < 0:
        parser.error("-n/--max-requests must be >= 0")

    root = repo_root()
    load_env_file(root)

    api_key = api_key_from_env()
    if not api_key:
        print(
            "No API key found. Use one of:\n"
            "  export POISK_KINO_API_KEY='your-token'\n"
            "  or create .env in the project root with: POISK_KINO_API_KEY=your-token\n"
            "  (aliases: POISK_KINO_TOKEN, X_API_KEY)\n"
            "Windows (cmd): set POISK_KINO_API_KEY=your-token",
            file=sys.stderr,
        )
        return 1

    in_path = resolve_under_root(root, args.input)
    if in_path is None:
        print(
            f"Input path must be inside project root: {args.input!r}",
            file=sys.stderr,
        )
        return 1
    if not in_path.is_file():
        print(f"Not found: {in_path}", file=sys.stderr)
        return 1

    pick_mode = (
        infer_mode_from_input_path(in_path)
        if args.mode == "auto"
        else args.mode
    )

    try:
        with open(in_path, encoding="utf-8") as f:
            data = json.load(f)
    except json.JSONDecodeError as e:
        print(f"Invalid JSON in {in_path}: {e}", file=sys.stderr)
        return 1

    if not isinstance(data, list):
        print(f"{in_path.name} must be a JSON array", file=sys.stderr)
        return 1

    if args.dry_run:
        print(
            f"Dry-run: no output file; {in_path.name} is only read, not modified.",
            file=sys.stderr,
        )

    out: list[dict] = []
    api_calls = 0
    quota_skipped = 0
    for i, entry in enumerate(data):
        if not isinstance(entry, dict):
            out.append(entry)
            continue

        q = build_query(entry)
        if not q:
            print(f"Row {i}: empty title, skipping API", file=sys.stderr)
            out.append(enrich_row(entry, None))
            continue

        if entry_has_all_ids(entry):
            if args.verbose:
                print(
                    f"Row {i} skip API (already has kinopoisk_id, imdb_id, tmdb_id)",
                    file=sys.stderr,
                )
            out.append(passthrough_row(entry))
            continue

        if args.max_requests is not None and api_calls >= args.max_requests:
            quota_skipped += 1
            if args.verbose:
                print(
                    f"Row {i}: skip API (request limit -n {args.max_requests} reached)",
                    file=sys.stderr,
                )
            out.append(passthrough_row(entry))
            continue

        docs, http_err = search(api_key, q)
        api_calls += 1
        if http_err == 401:
            print(
                "Aborting: API returned 401 (invalid token). Fix the key and run again.",
                file=sys.stderr,
            )
            return 2
        if args.verbose:
            print(f"Row {i} query={q!r} -> {len(docs)} hits", file=sys.stderr)
        doc = pick_doc(docs, pick_mode)
        if doc is None:
            print(f"Row {i}: no results for query={q!r}", file=sys.stderr)

        out.append(enrich_row(entry, doc))

        if i < len(data) - 1:
            time.sleep(REQUEST_DELAY_SEC)

    if args.max_requests is not None:
        print(
            f"API search requests this run: {api_calls} (limit {args.max_requests}).",
            file=sys.stderr,
        )
        if quota_skipped:
            print(
                f"Rows left without lookup due to limit: {quota_skipped}.",
                file=sys.stderr,
            )

    text = json.dumps(out, ensure_ascii=False, indent=2) + "\n"

    if args.dry_run:
        sys.stdout.write(text)
        return 0

    if args.output.strip():
        out_path = (root / args.output.strip()).resolve()
        try:
            out_path.relative_to(root.resolve())
        except ValueError:
            print(
                f"Refusing to write outside project root: {out_path}",
                file=sys.stderr,
            )
            return 1
    else:
        out_path = default_timestamped_output_path(root, in_path.stem)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(text, encoding="utf-8")
    print(f"Wrote {out_path} (read from {in_path}, mode={pick_mode})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
