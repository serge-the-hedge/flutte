#!/usr/bin/env python3
"""Compare real Convex text search with literal occurrences in the ARB fixtures.

Requires installed repository dependencies, Node, and a Convex local-backend binary.
Creates an isolated temporary project on localhost ports 3310/3311 and stops its
backend on completion. Never reads project deployment credentials.
"""

import argparse
import contextlib
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request


BASE_URL = "http://127.0.0.1:3310"
INSTANCE_NAME = "flutte-search-evaluation"
PORTS = (3310, 3311)
CASES = (
    ("zh", "text", "积木"),
    ("en", "text", "build"),
    ("en", "text", "license agreement"),
    ("en", "text", "agreement license"),
    ("fr", "text", "créé"),
    ("fr", "text", "cree"),
    ("de", "text", "Steine"),
    ("es", "text", "piezas"),
    ("ru", "text", "детали"),
    ("en", "key", "about_app_disclaimer"),
    ("en", "key", "disclaimer"),
    ("en", "key", "aboutapp"),
    ("en", "text", "rickit"),
)
SCHEMA = '''import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  examples: defineTable({ key: v.string(), locale: v.string(), text: v.string() })
    .searchIndex("search_text", { searchField: "text", filterFields: ["locale"] })
    .searchIndex("search_key", { searchField: "key", filterFields: ["locale"] }),
});
'''
FUNCTIONS = '''import {
  mutationGeneric as mutation,
  queryGeneric as query,
} from "convex/server";
import { v } from "convex/values";

export const seed = mutation({
  args: { rows: v.array(v.object({ key: v.string(), locale: v.string(), text: v.string() })) },
  handler: async (ctx, args) => {
    for (const row of args.rows) await ctx.db.insert("examples", row);
    return args.rows.length;
  },
});

export const search = query({
  args: {
    q: v.string(),
    locale: v.string(),
    field: v.union(v.literal("key"), v.literal("text")),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const result = await ctx.db.query("examples")
      .withSearchIndex(args.field === "key" ? "search_key" : "search_text", q =>
        q.search(args.field, args.q).eq("locale", args.locale))
      .paginate({ numItems: args.limit ?? 100, cursor: args.cursor ?? null });
    return { ...result, page: result.page.map(({ key, text }) => ({ key, text })) };
  },
});
'''


def require_free_ports():
    """Check both listening addresses before starting any local service."""
    with contextlib.ExitStack() as stack:
        for port in PORTS:
            connection = stack.enter_context(socket.socket())
            try:
                connection.bind(("127.0.0.1", port))
            except OSError as error:
                raise RuntimeError(f"Localhost port {port} is occupied.") from error


def prepare_project(directory, convex):
    (directory / "convex").mkdir()
    (directory / "node_modules").mkdir()
    (directory / "node_modules/convex").symlink_to(convex)
    version = json.loads((convex / "package.json").read_text())["version"]
    (directory / "package.json").write_text(json.dumps({
        "name": "flutte-native-search-evaluation",
        "private": True,
        "dependencies": {"convex": version},
    }))
    (directory / "convex/schema.ts").write_text(SCHEMA)
    (directory / "convex/probe.ts").write_text(FUNCTIONS)
    return version


def local_credentials(binary):
    secret = secrets.token_hex(32)
    try:
        generated = subprocess.run(
            [str(binary), "keygen", "admin-key", "--instance-name", INSTANCE_NAME,
             "--instance-secret", secret],
            capture_output=True, text=True, timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise RuntimeError("Could not generate isolated local credentials.") from error
    if generated.returncode != 0 or not generated.stdout.strip():
        # A failed process may echo its arguments; never print its output.
        raise RuntimeError("The local backend rejected credential generation.")
    return secret, generated.stdout.strip()


def wait_until_ready(backend):
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if backend.poll() is not None:
            raise RuntimeError("The spawned local backend exited before becoming ready.")
        try:
            with urllib.request.urlopen(BASE_URL + "/version", timeout=0.5) as response:
                response.read()
            if backend.poll() is not None:
                raise RuntimeError("The spawned local backend exited during its health check.")
            return
        except (urllib.error.URLError, TimeoutError):
            time.sleep(0.2)
    raise RuntimeError("The spawned local backend did not become ready within 20 seconds.")


def deploy(directory, convex, secret, admin):
    environment = {
        name: value for name, value in os.environ.items()
        if not name.startswith("CONVEX_")
    }
    environment.update(
        CONVEX_SELF_HOSTED_URL=BASE_URL,
        CONVEX_SELF_HOSTED_ADMIN_KEY=admin,
    )
    result = subprocess.run(
        ["node", str(convex / "bin/main.js"), "deploy", "--typecheck", "disable",
         "--codegen", "disable"],
        cwd=directory, env=environment, text=True, capture_output=True, timeout=120,
    )
    output = (result.stdout + result.stderr).replace(secret, "[redacted]")
    print(output.replace(admin, "[redacted]"), flush=True)
    if result.returncode != 0:
        raise RuntimeError("Deploying the isolated localhost experiment failed.")


def call_api(kind, function, arguments):
    request = urllib.request.Request(
        BASE_URL + "/api/" + kind,
        data=json.dumps({"path": function, "args": arguments, "format": "json"}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        result = json.load(response)
    if result["status"] != "success":
        raise RuntimeError(f"Experiment function {function} failed: {result.get('errorMessage')}")
    return result["value"]


def fixture_rows(root):
    rows = []
    for file in sorted((root / "packages/backend/fixtures/arb").glob("*.arb")):
        catalog = json.loads(file.read_text())
        locale = file.stem.removeprefix("intl_")
        rows.extend(
            {"key": key, "locale": locale, "text": value}
            for key, value in catalog.items() if not key.startswith("@")
        )
    if not rows:
        raise RuntimeError("The repository has no ARB fixture messages.")
    return rows


def evaluate(rows):
    for start in range(0, len(rows), 200):
        call_api("mutation", "probe:seed", {"rows": rows[start:start + 200]})
    print(f"Seeded {len(rows)} actual fixture pairs", flush=True)
    longest_key = max((row["key"] for row in rows), key=len)
    results = []
    for locale, field, query in (*CASES, ("en", "key", longest_key)):
        found = []
        cursor = None
        pages = 0
        while True:
            arguments = {"q": query, "locale": locale, "field": field, "limit": 25}
            if cursor:
                arguments["cursor"] = cursor
            page = call_api("query", "probe:search", arguments)
            found.extend(page["page"])
            pages += 1
            if page["isDone"]:
                break
            cursor = page["continueCursor"]
        literal = [
            row for row in rows
            if row["locale"] == locale and query.lower() in row[field].lower()
        ]
        result = {
            "locale": locale, "field": field, "query": query,
            "nativeCount": len(found), "literalCount": len(literal), "pages": pages,
            "nativeKeys": [row["key"] for row in found],
            "literalKeys": [row["key"] for row in literal], "examples": found[:3],
        }
        results.append(result)
        summary = {key: value for key, value in result.items()
                   if key not in ("nativeKeys", "literalKeys")}
        print(json.dumps(summary, ensure_ascii=False), flush=True)
    return results


def run_experiment(binary, output):
    root = Path(__file__).resolve().parents[2]
    convex = (root / "packages/backend/node_modules/convex").resolve()
    if not binary.is_file() or not (convex / "bin/main.js").is_file():
        raise RuntimeError("An existing backend binary and installed Convex dependency are required.")
    rows = fixture_rows(root)
    require_free_ports()
    secret, admin = local_credentials(binary)
    with tempfile.TemporaryDirectory(prefix="flutte-native-search-") as temporary:
        directory = Path(temporary)
        version = prepare_project(directory, convex)
        with (directory / "backend.log").open("w") as log:
            backend = subprocess.Popen(
                [str(binary), "--interface", "127.0.0.1", "--port", str(PORTS[0]),
                 "--site-proxy-port", str(PORTS[1]), "--instance-name", INSTANCE_NAME,
                 "--instance-secret", secret, "--disable-beacon", str(directory / "db.sqlite3"),
                 "--local-storage", str(directory / "storage")],
                stdout=log, stderr=subprocess.STDOUT, cwd=directory,
            )
            try:
                wait_until_ready(backend)
                print(f"Isolated backend ready; Convex CLI {version}", flush=True)
                deploy(directory, convex, secret, admin)
                output.write_text(json.dumps(evaluate(rows), ensure_ascii=False, indent=2))
            finally:
                backend.terminate()
                try:
                    backend.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    backend.kill()
                    backend.wait()
    print("Stopped local backend and removed temporary project", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backend", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    try:
        run_experiment(arguments.backend.expanduser().resolve(), arguments.output)
    except KeyboardInterrupt:
        print("Experiment interrupted.", file=sys.stderr)
        return 130
    except Exception as error:
        # Avoid tracebacks that can include subprocess command arguments.
        message = ("A subprocess exceeded its deadline." if isinstance(error, subprocess.TimeoutExpired)
                   else str(error))
        print(f"Experiment failed: {message}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
