"""Protocol Chaos for Hermes.

Brings the user's matters from their own Protocol Chaos server into the conversation before
the model answers, and records the user's words there after it answers. This client decides
what to read (PROTOCOL.md §10): the server receives requests for its directory, reads of
particular Events by id, and the words being recorded. It never receives the messages
themselves.

- When a session starts, the directory of open Events (titles, states, parts, progress) goes
  into the system prompt, so the model knows what the user has going on.
- ``pre_llm_call``: the message is compared with the directory's titles on this machine. For
  the few Events it plainly names, their goal, constraint, plan, progress and latest words are
  read by id and added to the turn, with their ids.
- ``post_llm_call``: in a background thread, the user's own model (Hermes's ``ctx.llm``)
  decides whether the message changes one of their Events or starts one, and which; if so the
  plugin records the user's words with ``event_note``, copied from the message itself, so they
  are always verbatim. Then it folds those words into that Event's fields (title, state,
  progress, goal, constraint, plan, the people and things involved) with
  ``event_record_expression``, grounded on the words just recorded, so the next turn and every
  other assistant see the change. Without ``ctx.llm`` the model is asked to record instead.
- A bundled skill, ``protocol-chaos:organizer``, does the rest of the organizing once a day
  (the hierarchy, duplicates, people and places); the plugin offers it as an automation
  blueprint, ``/blueprint protocol-chaos:organizer``.

Everything fails open: on any error the turn goes on exactly as it would without the plugin.
Logs carry ids and counts, never what the user said.

Settings: ``PROTOCOL_CHAOS_URL`` (the server's MCP endpoint) and ``PROTOCOL_CHAOS_TOKEN`` (the
bearer token the server issued for this Hermes), read through Hermes's secret scope; and,
under ``plugins.entries.protocol-chaos.settings``, ``actor`` (the client name the token was
issued for, default ``hermes``), ``capture`` (``auto``, ``model`` or ``off``), ``structure``
(``auto`` or ``off``) and ``overview`` (``auto``, ``prompt``, ``turn`` or ``off``).
"""

from __future__ import annotations

import contextvars
import hashlib
import http.client
import inspect
import json
import logging
import math
import re
import threading
import time
import urllib.parse
from collections import OrderedDict
from pathlib import Path
from typing import Any, Optional

log = logging.getLogger("protocol_chaos")

PLUGIN_VERSION = "0.2.1"
URL_SECRET = "PROTOCOL_CHAOS_URL"
TOKEN_SECRET = "PROTOCOL_CHAOS_TOKEN"
READ_TIMEOUT = 6.0
WRITE_TIMEOUT = 15.0
CAPTURE_TIMEOUT = 120.0
DIRECTORY_PAGE = 200
DIRECTORY_MAX = 2000
DIRECTORY_FRESH_SECONDS = 30.0
PROMPT_SECTION_CHARS = 3900  # Hermes caps a plugin's system prompt section at 4,000
TURN_OVERVIEW_CHARS = 5000
# Hermes moves hook context above 10,000 characters to a file and shows the model a preview.
MAX_TURN_CONTEXT_CHARS = 9500
RELATED_MAX = 3
# Scores count shared words in units of one word that appears in a single title.
RELATED_MIN_SCORE = 1.0
CANDIDATE_MIN_SCORE = 0.5
CAPTURE_LIST_CHARS = 6000
# The structure update: how many earlier words of the Event the model sees, and the longest fact
# it may rewrite (a longer one is left as it is, rather than shown cut and rewritten from a part).
STRUCTURE_WORDS = 6
FACT_LIMIT = 4000
MAX_NEW_REFS = 5
LEGACY_KEY = "dev.protocol-chaos/legacy-0.1"
FACT_KEYS = ("goal", "constraint", "plan")
STATES = ("emerging", "active", "waiting", "dormant", "done", "cancelled")
NOT_A_REF = frozenset({"me", "i", "myself", "user", "the user", "我", "我自己", "自己", "用户", "本人"})
MAX_SESSIONS = 200
CAPTURE_TASK = "protocol_chaos_capture"  # auxiliary task keys are letters, digits and underscores
ORGANIZER_BLUEPRINT = {
    "title": "Organize Protocol Chaos",
    "description": "Once a day, fold what was recorded in your Protocol Chaos repository into structure: "
                   "the hierarchy of matters, duplicates, people and places, and anything not structured yet. "
                   "Needs the protocol_chaos MCP server (see the plugin's README).",
    "category": "daily",
    "schedule_template": "{minute} {hour} * * *",
    "prompt_template": "Organize the user's Protocol Chaos repository: follow the protocol-chaos:organizer skill "
                       "exactly, and report as it says.",
    "slots": [
        {"name": "time", "type": "time", "label": "What time?", "default": "04:00",
         "help": "24h local time; a quiet hour is best"},
        {"name": "deliver", "type": "enum", "label": "Where to report?", "default": "origin",
         "options": ["origin", "local"], "strict": False},
    ],
    "skills": ["protocol-chaos:organizer"],
    "tags": ["protocol-chaos", "organizer", "daily"],
}
SKILLS_DIR = Path(__file__).parent / "skills"
HEADER = "[Protocol Chaos · added by the client, not written by the user]"
OVERVIEW_MARKER = "Protocol Chaos · the user's matters"
SHOWN_ID = re.compile(r"\[id:([^\]\s]+)\]")
OPEN_STATES = ("emerging", "active", "waiting", "dormant")
WRITE_TOOLS = ("event_note", "event_record_expression")
# Turns that are not the user talking: scheduled jobs (the organizer among them).
MACHINE_PLATFORMS = ("cron", "scheduler", "schedule")


# ---------------------------------------------------------------------------- settings


def read_secret(name: str) -> Optional[str]:
    """A credential through Hermes's secret scope (catalog rule 11), or None."""
    try:
        from agent.secret_scope import get_secret
    except ImportError:
        log.warning("protocol-chaos: this Hermes has no agent.secret_scope; update Hermes to use the plugin")
        return None
    try:
        value = get_secret(name)
    except Exception as error:  # e.g. no profile scope while multiplexing: stay idle this turn
        log.warning("protocol-chaos: %s not readable (%s)", name, type(error).__name__)
        return None
    return value.strip() if isinstance(value, str) and value.strip() else None


def config_value(ctx: Any, key: str, default: str, allowed: Optional[tuple] = None) -> str:
    getter = getattr(ctx, "get_config", None)
    try:
        value = getter(key, default) if callable(getter) else default
    except Exception:
        value = default
    value = str(value if value is not None else default).strip() or default
    if allowed is not None and value not in allowed:
        log.warning("protocol-chaos: setting %s=%r is not one of %s; using %s", key, value, ", ".join(allowed), default)
        return default
    return value


# ---------------------------------------------------------------------------- the repository


class ToolError(RuntimeError):
    """The repository answered, with an error."""

    def __init__(self, tool: str, code: str) -> None:
        super().__init__(f"{tool}: {code}")
        self.code = code


def why(error: BaseException) -> str:
    """What went wrong, for the log: an error code or an exception's type, never content."""
    return error.code if isinstance(error, ToolError) else type(error).__name__


class Repository:
    """Calls repository tools over MCP streamable HTTP (stateless, JSON responses).

    Reads keep one connection alive, so a turn does not pay a TLS handshake each time. Writes
    use a fresh connection and are never retried: a retried write could record words twice.
    """

    def __init__(self, url: str, token: str, keep_alive: bool) -> None:
        parts = urllib.parse.urlsplit(url)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            raise ValueError("PROTOCOL_CHAOS_URL is not an http(s) URL")
        self._https = parts.scheme == "https"
        self._host = parts.hostname
        self._port = parts.port
        self._path = (parts.path or "/") + (f"?{parts.query}" if parts.query else "")
        self._token = token
        self._keep_alive = keep_alive
        self._lock = threading.Lock()
        self._connection: Optional[http.client.HTTPConnection] = None
        self._next_id = 0

    def call(self, tool: str, arguments: dict, timeout: float) -> Any:
        with self._lock:
            self._next_id += 1
            body = json.dumps(
                {"jsonrpc": "2.0", "id": self._next_id, "method": "tools/call",
                 "params": {"name": tool, "arguments": arguments}},
                ensure_ascii=False,
            ).encode("utf-8")
            status, data = self._post(body, timeout, retry=self._keep_alive)
        if status != 200:
            raise ToolError(tool, f"HTTP {status}")
        payload = json.loads(data.decode("utf-8"))
        if "error" in payload:
            raise ToolError(tool, f"MCP {payload['error'].get('code', 'error')}")
        result = payload.get("result") or {}
        text = "".join(item.get("text", "") for item in result.get("content", []) if isinstance(item, dict))
        if result.get("isError"):
            try:
                code = str(json.loads(text).get("code") or "ERROR")
            except Exception:
                code = "ERROR"
            raise ToolError(tool, code)
        return json.loads(text) if text.strip().startswith(("{", "[")) else text

    def _post(self, body: bytes, timeout: float, retry: bool) -> tuple:
        headers = {
            "Authorization": f"Bearer {self._token}",
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "MCP-Protocol-Version": "2025-06-18",
        }
        for attempt in (1, 2):
            connection = self._open(timeout)
            try:
                connection.request("POST", self._path, body=body, headers=headers)
                response = connection.getresponse()
                data = response.read()
                if not self._keep_alive:
                    self._close()
                return response.status, data
            except (http.client.HTTPException, OSError):
                # An idle connection the server already closed fails on first use; a read
                # may safely go again on a new one.
                self._close()
                if attempt == 2 or not retry:
                    raise
        raise AssertionError("unreachable")

    def _open(self, timeout: float) -> http.client.HTTPConnection:
        if self._connection is None:
            factory = http.client.HTTPSConnection if self._https else http.client.HTTPConnection
            self._connection = factory(self._host, self._port, timeout=timeout)
        else:
            self._connection.timeout = timeout
            if self._connection.sock is not None:
                self._connection.sock.settimeout(timeout)
        return self._connection

    def close(self) -> None:
        with self._lock:
            self._close()

    def _close(self) -> None:
        if self._connection is not None:
            try:
                self._connection.close()
            except Exception:
                pass
        self._connection = None


class Connection:
    """The reads and writes of one server, and the directory cached for it."""

    def __init__(self, url: str, token: str) -> None:
        self.reads = Repository(url, token, keep_alive=True)
        self.writes = Repository(url, token, keep_alive=False)
        self.lock = threading.Lock()
        self.version: Optional[str] = None
        self.entries: list = []
        self.fetched = 0.0

    def directory(self, max_age: float = DIRECTORY_FRESH_SECONDS) -> list:
        """The directory, most recently updated first: fetched again only when it may be stale,
        and then only in full when the server says it changed."""
        with self.lock:
            if self.version is not None and time.monotonic() - self.fetched < max_age:
                return self.entries
            arguments: dict = {"limit": DIRECTORY_PAGE}
            if self.version is not None:
                arguments["sinceVersion"] = self.version
            first = self.reads.call("context_pack", arguments, READ_TIMEOUT)
            if not isinstance(first, dict):
                raise ToolError("context_pack", "UNEXPECTED")
            if not first.get("unchanged"):
                entries = [e for e in first.get("events") or [] if isinstance(e, dict) and e.get("id")]
                cursor = first.get("next")
                while cursor and len(entries) < DIRECTORY_MAX:
                    page = self.reads.call("context_pack", {"limit": DIRECTORY_PAGE, "cursor": cursor}, READ_TIMEOUT)
                    entries.extend(e for e in page.get("events") or [] if isinstance(e, dict) and e.get("id"))
                    cursor = page.get("next")
                self.entries = entries
                self.version = str(first.get("version") or "")
            self.fetched = time.monotonic()
            return self.entries

    def close(self) -> None:
        self.reads.close()
        self.writes.close()


# ---------------------------------------------------------------------------- matching, on this machine

_CJK = re.compile(r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]")
_WORD = re.compile(r"[0-9a-z]+(?:['’][a-z]+)?")
STOP_BIGRAMS = frozenset(
    "我们 你们 他们 一个 这个 那个 什么 怎么 今天 明天 昨天 现在 可以 已经 没有 不是 就是 还是 因为 所以 但是 如果 "
    "一下 一些 时候 自己 觉得 知道 需要 这样 那样 还有 然后 其实 应该 可能 东西 事情 帮我 我想 我要 一起 这些 那些".split()
)
STOP_WORDS = frozenset(
    "the a an and or to of in on for with my me i is it this that be at by we you our your are was "
    "do does did can will just about from have has had not but so if as".split()
)


def tokens(text: str) -> set:
    """Words and, for scripts written without spaces, pairs of adjacent characters."""
    text = (text or "").lower()
    found = set()
    run: list = []

    def flush() -> None:
        for i in range(len(run) - 1):
            pair = run[i] + run[i + 1]
            if pair not in STOP_BIGRAMS:
                found.add(pair)
        run.clear()

    for char in text:
        if _CJK.match(char):
            run.append(char)
        else:
            flush()
    flush()
    for word in _WORD.findall(text):
        if (len(word) >= 2 or word.isdigit()) and word not in STOP_WORDS:
            found.add(word)
    return found


def rank(message: str, entries: list, minimum: float, limit: int, exclude: set = frozenset()) -> list:
    """Directory entries whose titles share rare enough words with the message, best first.

    A shared word weighs by how few titles have it (inverse document frequency), scaled so
    that a word found in one title alone weighs 1, whatever the size of the directory."""
    wanted = tokens(message)
    if not wanted:
        return []
    titles = [(entry, tokens(str(entry.get("title") or ""))) for entry in entries]
    count = len(titles)
    frequency: dict = {}
    for _, words in titles:
        for word in words:
            frequency[word] = frequency.get(word, 0) + 1
    unique = math.log((count + 1) / 1.5)
    if unique <= 0:
        return []
    scored = []
    for entry, words in titles:
        if entry.get("id") in exclude:
            continue
        shared = wanted & words
        if not shared:
            continue
        score = sum(math.log((count + 1) / (frequency[word] + 0.5)) for word in shared) / unique
        if entry.get("state") not in OPEN_STATES:
            score *= 0.75
        if score >= minimum:
            scored.append((score, entry))
    scored.sort(key=lambda item: -item[0])
    return [entry for _, entry in scored[:limit]]


# ---------------------------------------------------------------------------- rendering


def clip(text: Any, limit: int) -> str:
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    return text if len(text) <= limit else text[: max(0, limit - 1)].rstrip() + "…"


def fit_lines(lines: list, budget: int, more: str) -> str:
    """As many leading lines as fit in ``budget`` characters, then ``more`` saying how many were left."""
    text = "\n".join(lines)
    if len(text) <= budget:
        return text
    kept = list(lines)
    while kept:
        note = more.format(len(lines) - len(kept))
        if len("\n".join(kept)) + len(note) + 1 <= budget:
            return "\n".join([*kept, note])
        kept.pop()
    return ""


def forest(entries: list) -> list:
    """(depth, entry) pairs: each entry under the first of its parents that is also listed, the
    order of the directory kept at every level."""
    listed = {entry["id"] for entry in entries}
    children: dict = {}
    roots = []
    for entry in entries:
        parent = next((p for p in entry.get("parents") or [] if p in listed and p != entry["id"]), None)
        if parent is None:
            roots.append(entry)
        else:
            children.setdefault(parent, []).append(entry)
    out: list = []
    seen: set = set()

    def walk(entry: dict, depth: int) -> None:
        if entry["id"] in seen:
            return
        seen.add(entry["id"])
        out.append((depth, entry))
        for child in children.get(entry["id"], []):
            walk(child, min(depth + 1, 4))

    for root in roots:
        walk(root, 0)
    for entry in entries:  # anything left (a cycle a server should have refused) still shows
        walk(entry, 0)
    return out


def overview_text(entries: list, budget: int) -> str:
    open_entries = [entry for entry in entries if entry.get("state") in OPEN_STATES]
    head = [
        f"{OVERVIEW_MARKER}, from their own Protocol Chaos repository (the client's overview, not their words).",
        "Open matters, most recently updated first; indented ones are parts of the one above.",
    ]
    if not open_entries:
        return "\n".join([*head, "- (none yet)"])
    lines = []
    for depth, entry in forest(open_entries):
        parts = [clip(entry.get("title") or "(untitled)", 80), str(entry.get("state"))]
        progress = (entry.get("progress") or {}).get("text") if isinstance(entry.get("progress"), dict) else None
        if progress:
            parts.append(clip(progress, 60))
        lines.append("  " * depth + "- " + " · ".join(parts))
    body = fit_lines(lines, budget - len("\n".join(head)) - 1, "- … and {} more (context_pack lists every matter)")
    return "\n".join([*head, body]) if body else "\n".join(head)


def matter_text(result: dict, by_id: dict, children: dict) -> str:
    event = result.get("event") or {}
    event_id = event.get("id")
    lines = [f"- {clip(event.get('title') or '(untitled)', 80)} · {event.get('state')} [id:{event_id}]"]
    facts = event.get("facts") or {}
    for key in ("goal", "constraint", "plan"):
        if facts.get(key):
            lines.append(f"  {key}: {clip(facts[key], 400)}")
    progress = event.get("progress")
    if isinstance(progress, dict) and progress.get("text"):
        lines.append(f"  progress: {clip(progress['text'], 200)} ({str(progress.get('timestamp') or '')[:10]})")
    names = {e.get("id"): e.get("name") for e in result.get("entities") or [] if isinstance(e, dict)}
    involves = [r.get("criteria") or names.get(r.get("ref")) or r.get("ref") for r in event.get("refs") or [] if isinstance(r, dict)]
    if involves:
        lines.append("  involves: " + "; ".join(clip(item, 60) for item in involves if item))
    for parent in event.get("parents") or []:
        title = (by_id.get(parent) or {}).get("title")
        lines.append(f"  part of: {clip(title or '(a matter not listed)', 60)} [id:{parent}]")
    parts = [entry for entry in children.get(event_id, []) if entry.get("state") in OPEN_STATES][:5]
    if parts:
        lines.append("  parts: " + "; ".join(f"{clip(p.get('title') or '(untitled)', 40)} [id:{p['id']}]" for p in parts))
    for account in (result.get("accounts") or [])[-2:]:
        if isinstance(account, dict) and account.get("text"):
            who = "" if account.get("source") == "user" else " (an assistant's note)"
            lines.append(f"  said {str(account.get('createdAt') or '')[:10]}{who}: {clip(account['text'], 240)}")
    return "\n".join(lines)


def children_of(entries: list) -> dict:
    out: dict = {}
    for entry in entries:
        for parent in entry.get("parents") or []:
            out.setdefault(parent, []).append(entry)
    return out


def candidate_list(message: str, entries: list) -> tuple:
    """The matters a recording decision may pick, as text with short refs, and ref -> id."""
    likely = rank(message, entries, CANDIDATE_MIN_SCORE, 8)
    likely_ids = {entry["id"] for entry in likely}
    by_id = {entry["id"]: entry for entry in entries}
    chosen = [entry for entry in entries if entry.get("state") in OPEN_STATES or entry["id"] in likely_ids]
    pairs = forest(chosen)
    lines = []
    refs: dict = {}
    for depth, entry in pairs:
        ref = f"m{len(refs) + 1}"
        refs[ref] = entry["id"]
        lines.append("  " * depth + f"- {ref}: {clip(entry.get('title') or '(untitled)', 60)} [{entry.get('state')}]")
    text = "\n".join(lines)
    if len(text) <= CAPTURE_LIST_CHARS:
        return text or "(none)", refs
    # Too many to list: the likely ones with their parents and parts, then the most recent.
    keep: list = []
    children = children_of(entries)
    for entry in likely:
        for parent in entry.get("parents") or []:
            if parent in by_id and by_id[parent] not in keep:
                keep.append(by_id[parent])
        if entry not in keep:
            keep.append(entry)
        keep.extend(child for child in children.get(entry["id"], [])
                    if child.get("state") in OPEN_STATES and child not in keep)
    lines, refs = [], {}
    for entry in keep + [e for e in entries if e.get("state") in OPEN_STATES and e not in keep]:
        ref = f"m{len(refs) + 1}"
        line = f"- {ref}: {clip(entry.get('title') or '(untitled)', 60)} [{entry.get('state')}]"
        if len("\n".join(lines)) + len(line) + 1 > CAPTURE_LIST_CHARS:
            break
        refs[ref] = entry["id"]
        lines.append(line)
    return "\n".join(lines) or "(none)", refs


# ---------------------------------------------------------------------------- conversation helpers


def message_text(message: Any) -> str:
    """The text of a turn's message: a string, or the text parts of a multimodal message."""
    if isinstance(message, str):
        return message
    if isinstance(message, list):
        return "\n".join(
            str(part.get("text", "")) for part in message if isinstance(part, dict) and part.get("type") == "text"
        )
    return ""


def accepts(function: Any, name: str) -> bool:
    """Whether a host function takes a keyword: older Hermes versions lack some."""
    try:
        parameters = inspect.signature(function).parameters
    except (TypeError, ValueError):
        return False
    return name in parameters or any(item.kind is inspect.Parameter.VAR_KEYWORD for item in parameters.values())


def _contents(history: Any):
    for message in history or []:
        if not isinstance(message, dict):
            continue
        # Hermes keeps what was sent, context added by plugins included, in ``api_content``.
        for key in ("content", "api_content"):
            content = message.get(key)
            if isinstance(content, str):
                yield content
            elif isinstance(content, list):
                for part in content:
                    if isinstance(part, dict) and isinstance(part.get("text"), str):
                        yield part["text"]


def shown_ids(history: Any) -> set:
    """Ids of matters whose details are already somewhere in the conversation."""
    return {match.group(1) for text in _contents(history) for match in SHOWN_ID.finditer(text)}


def history_has(history: Any, marker: str) -> bool:
    return any(marker in text for text in _contents(history))


def recorded_this_turn(history: Any) -> bool:
    """Whether the model already wrote to the repository during the current turn."""
    for message in reversed(list(history or [])):
        if not isinstance(message, dict):
            continue
        if message.get("role") == "user":
            return False
        for call in message.get("tool_calls") or []:
            function = (call or {}).get("function") or {}
            name = str(function.get("name") or call.get("name") or "")
            if any(name.endswith(tool) for tool in WRITE_TOOLS) and "chaos" in name:
                return True
    return False


def last_assistant_text(history: Any) -> str:
    """What the assistant said just before the current user message, for context."""
    seen_user = False
    for message in reversed(list(history or [])):
        if not isinstance(message, dict):
            continue
        if message.get("role") == "user":
            if seen_user:
                break
            seen_user = True
            continue
        if seen_user and message.get("role") == "assistant" and isinstance(message.get("content"), str):
            return message["content"]
    return ""


def _squash(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def verbatim_words(candidate: Any, message: str) -> str:
    """The part of the message the decision picked, if it really is part of it; else all of it."""
    if isinstance(candidate, str) and candidate.strip() and _squash(candidate) in _squash(message):
        return candidate.strip()
    return message.strip()


CAPTURE_SCHEMA = {
    "type": "object",
    "properties": {
        "record": {"type": "boolean"},
        "ref": {"type": ["string", "null"]},
        "title": {"type": ["string", "null"]},
        "parentRef": {"type": ["string", "null"]},
        "words": {"type": ["string", "null"]},
    },
    "required": ["record"],
}

CAPTURE_INSTRUCTIONS = (
    "You decide whether one message from the user is saved in their personal repository of long-lived matters, "
    "and where. Save it only when it changes something about one of their matters (its aim, its wishes or limits, "
    "its plan, its progress or its state) or starts a new one: an intention, plan, commitment, purchase, trip, "
    "target, arrangement, decision or correction about their own life or work that will still matter after this "
    "conversation, even casually and without dates; long-horizon aims count. Do not save questions, even about a "
    "matter, requests for information or advice, hypotheticals, instructions or requests for work, small talk, "
    "conversational turns such as 'ok' or 'continue', or one-off occurrences such as a meal, a workout or a "
    "payment. A bare request is not saved, but a feeling, news about their life or progress said in the same "
    "message is: 'how many calories is this? way too much, I'm trying to lose weight' is a limit on the "
    "weight-loss matter, 'friends are coming to stay and I want to get ready' starts a new one, 'three days of "
    "healthy eating so far' is progress. The listed matters show their parts indented under them: put the words "
    "on the most specific matter they are about and give its ref exactly as listed (such as m12). Otherwise give "
    "a title for a new matter, in the user's language, at most 30 characters, that names it on its own: what, and "
    "when or which where that tells it apart ('2027 年春天葡萄牙行', not '葡萄牙'); when it belongs under a listed "
    "matter, give that matter's ref as parentRef. words: the part of the message about this matter, copied "
    "character for character; usually the whole message. Answer in JSON."
)

STRUCTURE_SCHEMA = {
    "type": "object",
    "properties": {
        "change": {"type": "boolean"},
        "title": {"type": ["string", "null"]},
        "state": {"type": ["string", "null"]},
        "progress": {"type": ["string", "null"]},
        "goal": {"type": ["string", "null"]},
        "constraint": {"type": ["string", "null"]},
        "plan": {"type": ["string", "null"]},
        "involves": {"type": ["array", "null"], "items": {"type": "string"}},
    },
    "required": ["change"],
}

STRUCTURE_INSTRUCTIONS = (
    "You keep one of the user's long-lived matters up to date in their personal repository. You are given the "
    "matter as it stands, its earlier words, and the new words just said about it. Decide what the new words "
    "establish beyond what the matter already says, and answer with only those changes, leaving every other "
    "field null; if they establish nothing new, answer change: false. "
    "goal: what the matter is meant to achieve, including what would count as done. constraint: conditions it "
    "must meet: limits, deadlines, budgets, wishes and preferences, even a wish about a place or a time. plan: "
    "the arrangement as currently decided: when, where, how, which option. A wish moves from constraint into "
    "plan once it is decided; never put the same thing in both. A value you give replaces the stored one, so "
    "write its complete new content: everything that still holds plus the change, as natural language in the "
    "language of the user's words, clear on its own, never an object or a list. "
    "progress: where the matter stands now, in one short sentence, only when the words say how far it got. "
    "state, only when the words make it clear: active (being pursued), waiting (on something or someone), "
    "dormant (set aside), done (achieved), cancelled (given up). "
    "involves: people, places or things the words name that the matter does not list yet, each a short "
    "description in the user's terms such as 'my wife' or 'Lisbon'; never the user themself. "
    "title: only when the matter has none: what it is, and when or which where that tells it apart. "
    "Write relative times as concrete dates, counted from the day the new words were said. Never write 'the "
    "user'; write the facts themselves. Words marked as an assistant's note are an inference: fold them only as "
    "an inference with its basis, and never over the user's own words. Older details are things the user said "
    "before: when you write the aspect they belong to, fold in what still holds. Answer in JSON."
)


def fold_input(result: dict, account: dict) -> tuple:
    """The text the structure update shows the model, and the facts too long to rewrite."""
    event = result.get("event") or {}
    names = {e.get("id"): e.get("name") for e in result.get("entities") or [] if isinstance(e, dict)}
    facts = event.get("facts") or {}
    clipped = {key for key in FACT_KEYS if len(str(facts.get(key) or "")) > FACT_LIMIT}
    lines = [f"The new words were said on {str(account.get('createdAt') or '')[:10]} (UTC).", "", "The matter now:",
             f"title: {event.get('title') or '(none)'}", f"state: {event.get('state')}"]
    progress = event.get("progress")
    if isinstance(progress, dict) and progress.get("text"):
        lines.append(f"progress: {progress['text']} ({str(progress.get('timestamp') or '')[:10]})")
    else:
        lines.append("progress: (none)")
    for key in FACT_KEYS:
        if key in clipped:
            lines.append(f"{key}: (too long to show here; leave it null)")
        else:
            lines.append(f"{key}: {facts.get(key) or '(none)'}")
    involves = [r.get("criteria") or names.get(r.get("ref")) or "" for r in event.get("refs") or [] if isinstance(r, dict)]
    lines.append("involves: " + ("; ".join(item for item in involves if item) or "(none)"))
    legacy = (event.get("metadata") or {}).get(LEGACY_KEY)
    if legacy:
        lines.append("older details: " + clip(json.dumps(legacy, ensure_ascii=False), 1200))
    accounts = [a for a in result.get("accounts") or [] if isinstance(a, dict)]
    at = next((i for i, a in enumerate(accounts) if a.get("id") == account.get("id")), len(accounts))
    earlier = accounts[:at][-STRUCTURE_WORDS:]
    if earlier:
        lines += ["", "Earlier words, oldest first:"]
        for item in earlier:
            note = "" if item.get("source") == "user" else " (an assistant's note)"
            lines.append(f"- {str(item.get('createdAt') or '')[:10]}{note}: {clip(item.get('text'), 300)}")
    note = "" if account.get("source") == "user" else " (an assistant's note)"
    lines += ["", f"The new words{note}:", str(account.get("text") or "")]
    return "\n".join(lines), clipped


def structure_patch(event: dict, answer: Any, account: dict, clipped: set, known: Any = ()) -> dict:
    """A valid ``set`` holding only what the answer changes, each field whole (§5.3). ``known``: the
    names of the Entities the Event's refs already name, so they are not added again as words."""
    if not isinstance(answer, dict) or answer.get("change") is not True:
        return {}
    patch: dict = {}
    title = answer.get("title")
    if not event.get("title") and isinstance(title, str) and title.strip():
        patch["title"] = clip(title, 80)
    state = answer.get("state")
    if isinstance(state, str) and state.strip() in STATES and state.strip() != event.get("state"):
        patch["state"] = state.strip()
    progress = answer.get("progress")
    current = event.get("progress") if isinstance(event.get("progress"), dict) else {}
    if isinstance(progress, str) and progress.strip() and clip(progress, 300) != current.get("text"):
        patch["progress"] = {"text": clip(progress, 300), "timestamp": account.get("createdAt")}
    facts = {}
    stored = event.get("facts") or {}
    for key in FACT_KEYS:
        value = answer.get(key)
        if key not in clipped and isinstance(value, str) and value.strip() and value.strip() != stored.get(key):
            facts[key] = value.strip()
    if facts:
        patch["facts"] = facts
    involves = answer.get("involves")
    if isinstance(involves, list):
        refs = [dict(r) for r in event.get("refs") or [] if isinstance(r, dict)]
        seen = {str(r.get("criteria") or "").strip().lower() for r in refs} | {str(n).strip().lower() for n in known}
        added = []
        for item in involves:
            if not isinstance(item, str) or not item.strip() or len(added) >= MAX_NEW_REFS:
                continue
            criteria = clip(item, 80)
            key = criteria.lower()
            if key in seen or key in NOT_A_REF:
                continue
            seen.add(key)
            added.append({"criteria": criteria})
        if added:
            patch["refs"] = refs + added
    return patch


def unchanged_since(patch: dict, base: dict, current: dict) -> dict:
    """The part of a patch whose fields nobody else changed between ``base`` and ``current``."""
    out: dict = {}
    for field, value in patch.items():
        if field == "facts":
            kept = {key: v for key, v in value.items()
                    if (base.get("facts") or {}).get(key) == (current.get("facts") or {}).get(key)}
            if kept:
                out["facts"] = kept
        elif base.get(field) == current.get(field):
            out[field] = value
    return out


# ---------------------------------------------------------------------------- the plugin


class ProtocolChaosPlugin:
    def __init__(self, settings: dict, llm: Any = None, capture_task: Optional[str] = None) -> None:
        self.settings = settings
        self.actor = settings.get("actor") or "hermes"
        self.llm = llm if llm is not None and hasattr(llm, "complete_structured") else None
        self.capture_task = capture_task
        mode = settings.get("capture", "auto")
        if mode == "off":
            self.capture_mode = "off"
        elif mode == "auto" and self.llm is not None:
            self.capture_mode = "background"
        else:
            self.capture_mode = "model"
        # Folding words into fields needs the same model as the background recording.
        self.structure_mode = "auto" if self.capture_mode == "background" and settings.get("structure", "auto") == "auto" else "off"
        self.overview_in_prompt = False
        self._connections: dict = {}
        self._connections_lock = threading.Lock()
        self._sessions: "OrderedDict[str, dict]" = OrderedDict()
        self._sessions_lock = threading.Lock()
        self.threads: list = []  # background recordings, kept for tests

    # -- the server, per profile: the URL and token come from the active secret scope

    def connection(self) -> Optional[Connection]:
        url = read_secret(URL_SECRET)
        token = read_secret(TOKEN_SECRET)
        if not url or not token:
            return None
        key = hashlib.sha256(f"{url}\n{token}".encode("utf-8")).hexdigest()
        with self._connections_lock:
            connection = self._connections.get(key)
            if connection is None:
                try:
                    connection = Connection(url, token)
                except ValueError as error:
                    log.warning("protocol-chaos: %s", error)
                    return None
                self._connections[key] = connection
            return connection

    def close(self) -> None:
        with self._connections_lock:
            for connection in self._connections.values():
                connection.close()
            self._connections.clear()

    def _session(self, session_id: Any) -> dict:
        key = str(session_id or "default")
        with self._sessions_lock:
            state = self._sessions.pop(key, None) or {"overview_done": False, "shown": set(), "machine": False}
            self._sessions[key] = state
            while len(self._sessions) > MAX_SESSIONS:
                self._sessions.popitem(last=False)
            return state

    # -- reading

    def recording_note(self) -> str:
        if self.capture_mode == "background":
            return ("Recording happens in the background after you answer: do not call event_note for this message, "
                    "and do not search or re-read the repository for what is shown here.")
        if self.capture_mode == "model":
            return ("After answering, if the user's words change one of their matters or start one, record them with "
                    "one event_note: the id of the most specific matter shown with an [id:…] above, or a title, and "
                    "parentEventId when it belongs under one, for a new matter. A bare question or a one-off such as "
                    "a meal is not recorded; a feeling, news or progress said with it is. Do not re-read the "
                    "repository for what is shown here.")
        return "Do not search or re-read the repository for what is shown here."

    def prompt_section(self, session_info: Any = None) -> str:
        """The system prompt section of a new session: the overview, built once and cache-safe."""
        try:
            connection = self.connection()
            if connection is None:
                return ""
            note = self.recording_note()
            overview = overview_text(connection.directory(max_age=0), PROMPT_SECTION_CHARS - len(note) - 2)
            return f"{overview}\n\n{note}"
        except Exception as error:  # fail open: no section
            log.warning("protocol-chaos: overview skipped (%s)", why(error))
            return ""

    def pre_llm_call(self, session_id: Any = None, user_message: Any = None, conversation_history: Any = None,
                     is_first_turn: bool = False, **kwargs: Any) -> Optional[dict]:
        state = self._session(session_id)
        # A subagent's message is another agent's task, and a scheduled job's is a prompt: neither
        # is the user talking, so they get no context and nothing of theirs is recorded.
        state["machine"] = bool(kwargs.get("parent_session_id")) or str(kwargs.get("platform") or "") in MACHINE_PLATFORMS
        if state["machine"]:
            return None
        connection = self.connection()
        if connection is None:
            return None
        try:
            entries = connection.directory()
        except Exception as error:
            log.warning("protocol-chaos: directory unavailable (%s)", why(error))
            return None
        parts = []
        if (not self.overview_in_prompt and self.settings.get("overview", "auto") in ("auto", "turn")
                and not state["overview_done"] and not history_has(conversation_history, OVERVIEW_MARKER)):
            parts.append(overview_text(entries, TURN_OVERVIEW_CHARS))
        state["overview_done"] = True
        text = message_text(user_message)
        if text.strip() and not text.lstrip().startswith("/"):
            exclude = set(state["shown"]) | shown_ids(conversation_history)
            matches = rank(text, entries, RELATED_MIN_SCORE, RELATED_MAX, exclude)
            if matches:
                by_id = {entry["id"]: entry for entry in entries}
                children = children_of(entries)
                blocks = []
                for entry in matches:
                    try:
                        # Only the id goes to the server: the message stays on this machine.
                        result = connection.reads.call("event_get_protocol", {"eventId": entry["id"], "accounts": 3}, READ_TIMEOUT)
                    except Exception as error:
                        log.warning("protocol-chaos: a matter could not be read (%s)", why(error))
                        continue
                    if isinstance(result, dict) and isinstance(result.get("event"), dict):
                        blocks.append(matter_text(result, by_id, children))
                        state["shown"].add(entry["id"])
                if blocks:
                    parts.append("Matters this message may be about (picked by the client from their titles):\n"
                                 + "\n".join(blocks))
                    log.info("protocol-chaos: %d related matter(s)", len(blocks))
        if not parts:
            return None
        note = self.recording_note()
        budget = MAX_TURN_CONTEXT_CHARS - len(HEADER) - len(note) - 6
        body = "\n\n".join(parts)
        if len(body) > budget:
            body = body[: budget - 1].rstrip() + "…"
        return {"context": "\n\n".join([HEADER, body, note])}

    # -- writing

    def post_llm_call(self, session_id: Any = None, user_message: Any = None, assistant_response: Any = None,
                      conversation_history: Any = None, **kwargs: Any) -> None:
        if self.capture_mode != "background":
            return None
        platform = str(kwargs.get("platform") or "")
        text = message_text(user_message).strip()
        state = self._session(session_id)
        if (len(text) < 4 or text.startswith("/") or state.get("machine") or platform in MACHINE_PLATFORMS
                or kwargs.get("parent_session_id") or recorded_this_turn(conversation_history)):
            return None
        before = last_assistant_text(conversation_history)
        # The worker carries this turn's context (Hermes's secret scope among it), so it reads
        # the same profile's credentials as the turn.
        run = contextvars.copy_context().run
        thread = threading.Thread(target=run, args=(self.capture, text, before), daemon=True,
                                  name="protocol-chaos-capture")
        self.threads = [item for item in self.threads if item.is_alive()] + [thread]
        thread.start()
        return None

    def decide(self, text: str, listed: str, before: str) -> Optional[dict]:
        context = f"What the assistant had just said (context only):\n{before[:600]}\n\n" if before else ""
        arguments: dict = {
            "instructions": CAPTURE_INSTRUCTIONS,
            "input": [{"type": "text", "text": f"{context}The user's matters in the repository:\n{listed}\n\n"
                                               f"The user's message:\n{text}"}],
            "json_schema": CAPTURE_SCHEMA,
            "purpose": "protocol-chaos.capture",
            "temperature": 0.0,
            "max_tokens": 300,
            "timeout": CAPTURE_TIMEOUT,
        }
        if self.capture_task and accepts(self.llm.complete_structured, "task"):
            arguments["task"] = self.capture_task
        result = self.llm.complete_structured(**arguments)
        parsed = getattr(result, "parsed", None)
        return parsed if isinstance(parsed, dict) else None

    def capture(self, text: str, before: str = "") -> Optional[dict]:
        try:
            connection = self.connection()
            if connection is None:
                return None
            listed, refs = candidate_list(text, connection.directory())
            decision = self.decide(text, listed, before)
            if not decision or decision.get("record") is not True:
                return None
            arguments: dict = {
                "actor": {"kind": "agent", "id": self.actor},
                "accountSource": "user",
                "text": verbatim_words(decision.get("words"), text),
            }
            # Only refs that were listed count; anything else starts a new matter.
            event_id = refs.get(str(decision.get("ref") or "").strip())
            if event_id:
                arguments["eventId"] = event_id
            else:
                title = decision.get("title")
                if isinstance(title, str) and title.strip():
                    arguments["title"] = clip(title, 80)
                parent_id = refs.get(str(decision.get("parentRef") or "").strip())
                if parent_id:
                    arguments["parentEventId"] = parent_id
            receipt = connection.writes.call("event_note", arguments, WRITE_TIMEOUT)
            if not isinstance(receipt, dict):
                return None
            with connection.lock:
                connection.fetched = 0.0  # the directory changed
            log.info("protocol-chaos: recorded on %s (%s)", receipt.get("eventId"), ",".join(receipt.get("changed") or []))
        except Exception as error:
            log.warning("protocol-chaos: recording skipped (%s)", why(error))
            return None
        if self.structure_mode == "auto":
            self.structure(connection, receipt)
        return receipt

    def fold_answer(self, text: str) -> Optional[dict]:
        arguments: dict = {
            "instructions": STRUCTURE_INSTRUCTIONS,
            "input": [{"type": "text", "text": text}],
            "json_schema": STRUCTURE_SCHEMA,
            "purpose": "protocol-chaos.structure",
            "temperature": 0.0,
            "max_tokens": 2000,
            "timeout": CAPTURE_TIMEOUT,
        }
        if self.capture_task and accepts(self.llm.complete_structured, "task"):
            arguments["task"] = self.capture_task
        result = self.llm.complete_structured(**arguments)
        parsed = getattr(result, "parsed", None)
        return parsed if isinstance(parsed, dict) else None

    def structure(self, connection: Connection, receipt: dict) -> Optional[dict]:
        """Folds the words just recorded into their Event's fields: the per-message part of
        organizing, grounded on those words (``accountId``). When someone else wrote in between,
        it reads again once and keeps whatever they changed."""
        event_id, account_id = receipt.get("eventId"), receipt.get("accountId")
        if not event_id or not account_id:
            return None
        answer = None
        base: dict = {}
        try:
            for attempt in (1, 2):
                result = connection.reads.call(
                    "event_get_protocol", {"eventId": event_id, "accounts": STRUCTURE_WORDS + 1}, READ_TIMEOUT
                )
                event = result.get("event") if isinstance(result, dict) else None
                accounts = [a for a in (result or {}).get("accounts") or [] if isinstance(a, dict)] if isinstance(result, dict) else []
                account = next((a for a in accounts if a.get("id") == account_id), None)
                if not isinstance(event, dict) or account is None:
                    return None
                if answer is None:
                    text, clipped = fold_input(result, account)
                    answer = self.fold_answer(text)
                    base = event
                else:
                    clipped = {key for key in FACT_KEYS if len(str((event.get("facts") or {}).get(key) or "")) > FACT_LIMIT}
                known = [e.get("name") for e in result.get("entities") or [] if isinstance(e, dict) and e.get("name")]
                patch = structure_patch(event, answer, account, clipped, known)
                if attempt == 2:
                    patch = unchanged_since(patch, base, event)
                if not patch:
                    return None
                try:
                    done = connection.writes.call("event_record_expression", {
                        "eventId": event_id,
                        "actor": {"kind": "agent", "id": self.actor},
                        "text": account.get("text"),
                        "accountSource": account.get("source") or "user",
                        "accountId": account_id,
                        "expectedVersion": event.get("version"),
                        "set": patch,
                    }, WRITE_TIMEOUT)
                except ToolError as error:
                    if error.code == "VERSION_CONFLICT" and attempt == 1:
                        continue
                    raise
                with connection.lock:
                    connection.fetched = 0.0
                if isinstance(done, dict):
                    log.info("protocol-chaos: structured %s (%s)", event_id, ",".join(done.get("changed") or []))
                return done if isinstance(done, dict) else None
        except Exception as error:
            log.warning("protocol-chaos: structure skipped (%s)", why(error))
        return None


def register(ctx: Any) -> None:
    """Called by Hermes when the plugin loads. Nothing here reads a credential: the URL and token
    are read on each use, under the profile the turn runs in."""
    settings = {
        "actor": config_value(ctx, "actor", "hermes"),
        "capture": config_value(ctx, "capture", "auto", ("auto", "model", "off")),
        "structure": config_value(ctx, "structure", "auto", ("auto", "off")),
        "overview": config_value(ctx, "overview", "auto", ("auto", "prompt", "turn", "off")),
    }
    try:
        llm = getattr(ctx, "llm", None)
    except Exception:  # building the facade can fail on a misconfigured host
        llm = None
    task = None
    if llm is not None and hasattr(llm, "complete_structured") and hasattr(ctx, "register_auxiliary_task"):
        try:
            options: dict = {
                "display_name": "Protocol Chaos capture",
                "description": "Decides, after each answer, whether the user's message is worth recording, and where.",
            }
            # Where supported, use the model configured for compression: a small, cheap one.
            if accepts(ctx.register_auxiliary_task, "inherit_from"):
                options["inherit_from"] = "compression"
            ctx.register_auxiliary_task(CAPTURE_TASK, **options)
            task = CAPTURE_TASK
        except Exception as error:
            log.info("protocol-chaos: auxiliary task not registered (%s)", type(error).__name__)
    if hasattr(ctx, "register_skill") and SKILLS_DIR.is_dir():
        for child in sorted(SKILLS_DIR.iterdir()):
            skill = child / "SKILL.md"
            if child.is_dir() and skill.is_file():
                try:
                    ctx.register_skill(child.name, skill)
                except Exception as error:
                    log.info("protocol-chaos: skill %s not registered (%s)", child.name, type(error).__name__)
    if hasattr(ctx, "register_automation_blueprint"):  # Hermes 0.21.7 and later
        try:
            ctx.register_automation_blueprint("organizer", **ORGANIZER_BLUEPRINT)
        except Exception as error:
            log.info("protocol-chaos: organizer blueprint not registered (%s)", type(error).__name__)
    plugin = ProtocolChaosPlugin(settings, llm=llm, capture_task=task)
    if settings["overview"] in ("auto", "prompt") and hasattr(ctx, "register_system_prompt_section"):
        try:
            ctx.register_system_prompt_section(
                "protocol-chaos.overview", plugin.prompt_section, position="after_memory", max_chars=4000
            )
            plugin.overview_in_prompt = True
        except Exception as error:
            log.info("protocol-chaos: the overview goes into the first turn instead (%s)", type(error).__name__)
    ctx.register_hook("pre_llm_call", plugin.pre_llm_call)
    ctx.register_hook("post_llm_call", plugin.post_llm_call)
    log.info(
        "protocol-chaos %s: overview in %s, recording %s, structure %s",
        PLUGIN_VERSION, "system prompt" if plugin.overview_in_prompt else "first turn", plugin.capture_mode,
        plugin.structure_mode,
    )
