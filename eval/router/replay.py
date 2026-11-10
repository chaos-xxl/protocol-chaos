"""Offline replay of the Hermes plugin's router on the matter benchmark's stores and requests.

No network and no model: the plugin's own rank() and matter_text() are imported unchanged and
given each store's directory and matters, the way the server would return them. See README.md.

Usage: python3 eval/router/replay.py <matters-cache> <out-directory>
"""
from __future__ import annotations

import importlib.util
import json
import math
import re
import statistics
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PLUGIN = ROOT / "integrations" / "hermes" / "protocol-chaos" / "__init__.py"


def load_plugin():
    spec = importlib.util.spec_from_file_location("protocol_chaos_plugin", PLUGIN)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


pc = load_plugin()
NUMBER = re.compile(r"\d[\d,.:/\-]*\d|\d")


def store(cache: Path, case: str) -> tuple:
    """The directory entries and, by id, what event_get_protocol would return (last 3 words)."""
    data = json.loads((cache / "stores" / case / "protocol" / "repository.json").read_text())
    entries, results = [], {}
    for item in data["events"]:
        event = item["event"]
        entries.append({key: event.get(key) for key in ("id", "title", "state", "parents", "progress", "updatedAt")})
        results[event["id"]] = {"event": event, "accounts": (item.get("accounts") or [])[-3:]}
    return entries, results


def fields_text(event: dict) -> str:
    facts = event.get("facts") or {}
    progress = (event.get("progress") or {}).get("text") or ""
    return " ".join([event.get("title") or "", facts.get("goal") or "", facts.get("constraint") or "",
                     facts.get("plan") or "", progress])


def rank_fields(message: str, entries: list, results: dict, minimum: float, limit: int) -> list:
    """rank()'s weighing, over each matter's fields instead of its title alone."""
    wanted = pc.tokens(message)
    docs = [(entry, pc.tokens(fields_text(results[entry["id"]]["event"]))) for entry in entries]
    count = len(docs)
    frequency: dict = {}
    for _, words in docs:
        for word in words:
            frequency[word] = frequency.get(word, 0) + 1
    unique = math.log((count + 1) / 1.5)
    scored = []
    for entry, words in docs:
        shared = wanted & words
        if not shared:
            continue
        score = sum(math.log((count + 1) / (frequency[word] + 0.5)) for word in shared) / unique
        if entry.get("state") not in pc.OPEN_STATES:
            score *= 0.75
        if score >= minimum:
            scored.append((score, entry))
    scored.sort(key=lambda item: -item[0])
    return [entry for _, entry in scored[:limit]]


def rank_embedding(request_id: str, entries: list, similarity: dict, limit: int) -> list:
    by_title = {entry["title"]: entry for entry in entries}
    ordered = sorted(similarity[request_id].items(), key=lambda item: -item[1])
    return [by_title[title] for title, _ in ordered[:limit] if title in by_title]


ROUTERS = {
    "plugin": lambda r, e, res, sim: pc.rank(r["request"], e, pc.RELATED_MIN_SCORE, pc.RELATED_MAX),
    "plugin-0.5": lambda r, e, res, sim: pc.rank(r["request"], e, 0.5, pc.RELATED_MAX),
    "fields": lambda r, e, res, sim: rank_fields(r["request"], e, res, pc.RELATED_MIN_SCORE, pc.RELATED_MAX),
    "embed-3": lambda r, e, res, sim: rank_embedding(r["id"], e, sim, 3),
    "embed-5": lambda r, e, res, sim: rank_embedding(r["id"], e, sim, 5),
}


def pushed_text(picks: list, entries: list, results: dict) -> str:
    by_id = {entry["id"]: entry for entry in entries}
    children = pc.children_of(entries)
    return "\n".join(pc.matter_text(results[entry["id"]], by_id, children) for entry in picks)


ISO_DATE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")


def present(number: str, text: str) -> bool:
    """Whether a number from a fact is in the text; an ISO date also counts as 11-22, 11/22 or 11 月 22."""
    if number in text:
        return True
    date = ISO_DATE.match(number)
    if not date:
        return False
    month, day = int(date.group(2)), int(date.group(3))
    forms = [f"{month}-{day}", f"{month:02d}-{day:02d}", f"{month}/{day}", f"{month:02d}/{day:02d}"]
    return any(form in text for form in forms) or re.search(rf"(?<!\d)0?{month}\s*月\s*0?{day}(?!\d)", text) is not None


def facts_covered(facts: list, text: str) -> tuple:
    checked = covered = 0
    for fact in facts:
        numbers = [n.rstrip(".") for n in NUMBER.findall(fact)]
        if not numbers:
            continue
        checked += 1
        if all(present(n, text) for n in numbers):
            covered += 1
    return checked, covered


def pct(part: float, whole: float) -> str:
    return "—" if not whole else f"{100 * part / whole:.1f}%"


def main(cache: Path, out: Path) -> None:
    requests = json.loads((cache / "requests.json").read_text())["kept"]
    similarity = json.loads((cache / "similarity.json").read_text())
    stores = {}
    for case in sorted({r["case"] for r in requests}):
        stores[case] = store(cache, case)
    records = []
    timings = []
    for r in requests:
        entries, results = stores[r["case"]]
        start = time.perf_counter()
        pc.rank(r["request"], entries, pc.RELATED_MIN_SCORE, pc.RELATED_MAX)
        timings.append(time.perf_counter() - start)
        row = {"id": r["id"], "kind": r["kind"], "request": r["request"], "routers": {}}
        for name, router in ROUTERS.items():
            picks = router(r, entries, results, similarity)
            text = pushed_text(picks, entries, results)
            titles = [entry["title"] for entry in picks]
            item = {"picked": titles, "chars": len(text)}
            if r["kind"] == "needs":
                needed = set(r["matters"])
                item["all"] = needed <= set(titles)
                item["any"] = bool(needed & set(titles))
                parents = set(r.get("context") or []) - needed
                if parents:
                    item["parents"] = sorted(parents & set(titles))
                    item["parents_needed"] = sorted(parents)
                if item["all"]:
                    item["facts_checked"], item["facts_covered"] = facts_covered(r.get("facts") or [], text)
            elif r["kind"] == "adjacent":
                item["resembled"] = r["matter"] in titles
            row["routers"][name] = item
        records.append(row)
    out.mkdir(parents=True, exist_ok=True)
    (out / "picks.json").write_text(json.dumps(records, ensure_ascii=False, indent=1))

    lines = ["# Router replay on the matter benchmark", "",
             f"{len(requests)} requests ({sum(r['kind'] == 'needs' for r in requests)} needs, "
             f"{sum(r['kind'] == 'adjacent' for r in requests)} adjacent, "
             f"{sum(r['kind'] == 'unrelated' for r in requests)} unrelated) on {len(stores)} stores. "
             f"`rank()` takes {1000 * statistics.mean(timings):.1f} ms on average "
             f"(max {1000 * max(timings):.1f} ms) on a directory of about 150 matters.", "",
             "| Router | Needs: all picked | Needs: any picked | Parents picked | Facts in pushed text | "
             "Adjacent: resembled picked | Unrelated: anything picked | Matters per turn (needs / adjacent / unrelated) | "
             "Characters per turn (needs / adjacent / unrelated) |",
             "|---|---|---|---|---|---|---|---|---|"]
    summary = {}
    for name in ROUTERS:
        rows = {kind: [rec["routers"][name] for rec in records if rec["kind"] == kind] for kind in ("needs", "adjacent", "unrelated")}
        needs, adjacent, unrelated = rows["needs"], rows["adjacent"], rows["unrelated"]
        parents_needed = sum(len(x.get("parents_needed", [])) for x in needs)
        parents_got = sum(len(x.get("parents", [])) for x in needs)
        checked = sum(x.get("facts_checked", 0) for x in needs)
        covered = sum(x.get("facts_covered", 0) for x in needs)
        per = " / ".join(f"{statistics.mean(len(x['picked']) for x in rows[k]):.1f}" for k in rows)
        chars = " / ".join(f"{statistics.mean(x['chars'] for x in rows[k]):.0f}" for k in rows)
        values = {
            "all": sum(x["all"] for x in needs), "any": sum(x["any"] for x in needs), "needs": len(needs),
            "parents": parents_got, "parents_needed": parents_needed, "facts": covered, "facts_checked": checked,
            "adjacent": sum(x["resembled"] for x in adjacent), "adjacent_n": len(adjacent),
            "unrelated": sum(bool(x["picked"]) for x in unrelated), "unrelated_n": len(unrelated),
        }
        summary[name] = values
        lines.append(f"| `{name}` | {values['all']}/{len(needs)} ({pct(values['all'], len(needs))}) | "
                     f"{values['any']}/{len(needs)} ({pct(values['any'], len(needs))}) | {parents_got}/{parents_needed} | "
                     f"{covered}/{checked} ({pct(covered, checked)}) | "
                     f"{values['adjacent']}/{len(adjacent)} ({pct(values['adjacent'], len(adjacent))}) | "
                     f"{values['unrelated']}/{len(unrelated)} ({pct(values['unrelated'], len(unrelated))}) | {per} | {chars} |")
    plugin = summary["plugin"]
    lines += ["", "## Against the bar written before the run", "",
              f"- Every needed matter picked: {pct(plugin['all'], plugin['needs'])} (bar: at least 90%).",
              f"- Nothing pushed for an unrelated request: {pct(plugin['unrelated_n'] - plugin['unrelated'], plugin['unrelated_n'])} (bar: at least 90%).",
              "", "## Needs requests the shipped router misses", ""]
    for rec in records:
        item = rec["routers"]["plugin"]
        if rec["kind"] == "needs" and not item["all"]:
            needed = next(r for r in requests if r["id"] == rec["id"])["matters"]
            lines.append(f"- `{rec['id']}`: {rec['request']} — needs {'、'.join(needed)}; picked "
                         f"{'、'.join(item['picked']) or 'nothing'}")
    lines += ["", "## Unrelated requests that get a push", ""]
    for rec in records:
        item = rec["routers"]["plugin"]
        if rec["kind"] == "unrelated" and item["picked"]:
            lines.append(f"- `{rec['id']}`: {rec['request']} — picked {'、'.join(item['picked'])}")
    (out / "report.md").write_text("\n".join(lines) + "\n")
    (out / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=1))
    print("\n".join(lines))


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
