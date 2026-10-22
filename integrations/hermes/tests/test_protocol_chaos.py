"""Tests of the Hermes plugin against the real draft 0.2 reference server, over HTTP.

Run from the repository root (needs Node for the server):

    python3 -m unittest discover -s integrations/hermes/tests

Hermes itself is not needed: stand-ins shaped like its plugin interface load the plugin, and a
fake ``agent.secret_scope`` holds the URL and token.
"""

from __future__ import annotations

import importlib.util
import json
import logging
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
PLUGIN_DIR = ROOT / "integrations" / "hermes" / "protocol-chaos"
SERVER = ROOT / "server" / "index.mjs"
NODE = shutil.which("node")

SECRETS: dict = {}


def install_secret_scope() -> None:
    agent = types.ModuleType("agent")
    agent.__path__ = []  # a package
    scope = types.ModuleType("agent.secret_scope")
    scope.get_secret = lambda name, default=None: SECRETS.get(name, default)
    sys.modules["agent"] = agent
    sys.modules["agent.secret_scope"] = scope


def load_plugin():
    sys.dont_write_bytecode = True  # leave no __pycache__ in the plugin directory
    spec = importlib.util.spec_from_file_location(
        "protocol_chaos_plugin_under_test", PLUGIN_DIR / "__init__.py", submodule_search_locations=[str(PLUGIN_DIR)]
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


class FakeResult:
    def __init__(self, parsed):
        self.parsed = parsed


class FakeLlm:
    """Answers each recording decision with what the test set, and keeps the requests."""

    def __init__(self):
        self.decision = {"record": False}
        self.calls = []

    def complete_structured(self, *, instructions, input, json_schema=None, purpose=None, temperature=None,
                            max_tokens=None, timeout=None, task=None, **kwargs):
        self.calls.append({"input": input, "task": task, "purpose": purpose})
        decision = self.decision(input) if callable(self.decision) else self.decision
        return FakeResult(decision)


class NewHermes:
    """The plugin interface of current Hermes: prompt sections, ctx.llm, auxiliary tasks, skills."""

    def __init__(self, settings=None):
        self.hooks = {}
        self.sections = {}
        self.tasks = {}
        self.skills = {}
        self.llm = FakeLlm()
        self.settings = settings or {}

    def get_config(self, key, default=None):
        return self.settings.get(key, default)

    def register_hook(self, name, callback):
        self.hooks[name] = callback

    def register_system_prompt_section(self, id, content, *, position="after_memory", max_chars=4000):
        self.sections[id] = (content, max_chars)

    def register_auxiliary_task(self, key, *, display_name, description, defaults=None, inherit_from=None):
        self.tasks[key] = inherit_from

    def register_skill(self, name, path, description="", frontmatter=None):
        self.skills[name] = Path(path)


class OldHermes:
    """Only hooks: no prompt sections, no ctx.llm, no configuration."""

    def __init__(self):
        self.hooks = {}

    def register_hook(self, name, callback):
        self.hooks[name] = callback


class RecordingContext:
    """Shaped like the capability probe of `hermes plugins validate`: every other surface is a no-op."""

    def __init__(self):
        self.hooks = []

    def register_hook(self, name, callback):
        self.hooks.append(name)

    def register_tool(self, name, *args, **kwargs):
        raise AssertionError("the plugin declares no tools")

    def register_middleware(self, kind, callback):
        raise AssertionError("the plugin declares no middleware")

    def get_config(self, key, default=None):
        return default

    def __getattr__(self, name):
        if name in ("register_system_prompt_section", "register_auxiliary_task", "register_skill"):
            return lambda *args, **kwargs: None
        raise AttributeError(name)


@unittest.skipIf(NODE is None, "needs Node for the reference server")
class PluginTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        install_secret_scope()
        cls.plugin = load_plugin()
        cls.data = tempfile.mkdtemp(prefix="pc-hermes-")
        out = subprocess.run([NODE, str(SERVER), "clients", "add", "hermes", "--data", cls.data],
                             capture_output=True, text=True, check=True).stdout
        cls.token = re.search(r"^  (pc_[A-Za-z0-9_-]+)$", out, re.M).group(1)
        cls.port = free_port()
        cls.server = subprocess.Popen([NODE, str(SERVER), "--http", f"127.0.0.1:{cls.port}", "--data", cls.data],
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.time() + 15
        while True:
            try:
                socket.create_connection(("127.0.0.1", cls.port), timeout=0.5).close()
                break
            except OSError:
                if time.time() > deadline:
                    raise
                time.sleep(0.1)
        cls.url = f"http://127.0.0.1:{cls.port}/mcp"
        cls.repo = cls.plugin.Repository(cls.url, cls.token, keep_alive=False)
        cls.seed()

    @classmethod
    def tearDownClass(cls):
        cls.server.terminate()
        cls.server.wait(timeout=10)
        shutil.rmtree(cls.data, ignore_errors=True)

    @classmethod
    def note(cls, text, **fields):
        return cls.repo.call("event_note", {"actor": {"kind": "agent", "id": "hermes"}, "text": text, **fields}, 10)

    @classmethod
    def seed(cls):
        cls.travel = cls.note("I want to travel more.", title="多出去走走")["eventId"]
        trip = cls.note("Next spring I want to walk in Portugal with Mei.", title="2027 年春天葡萄牙行", parentEventId=cls.travel)
        cls.trip = trip["eventId"]
        cls.repo.call("event_record_expression", {
            "eventId": cls.trip, "actor": {"kind": "agent", "id": "hermes"}, "expectedVersion": trip["version"],
            "accountId": trip["accountId"], "text": "Next spring I want to walk in Portugal with Mei.",
            "set": {"state": "active", "facts": {"goal": "Walk in Portugal with Mei in spring 2027.",
                                                 "constraint": "Under 20,000 yuan; stay near the old town."},
                    "progress": {"text": "Looking at routes", "timestamp": "2026-10-01T02:00:00.000Z"},
                    "refs": [{"criteria": "Lisbon"}]},
        }, 10)
        cls.flights = cls.note("Book the flights to Lisbon.", title="2027 年葡萄牙行机票", parentEventId=cls.trip)["eventId"]
        cls.flat = cls.note("We will renovate the flat this winter.", title="2026 年冬天装修")["eventId"]
        done = cls.note("I renewed my passport.", title="2026 年护照续签")
        cls.repo.call("event_record_expression", {
            "eventId": done["eventId"], "actor": {"kind": "agent", "id": "hermes"}, "expectedVersion": done["version"],
            "accountId": done["accountId"], "text": "I renewed my passport.", "set": {"state": "done"},
        }, 10)
        cls.done = done["eventId"]

    def setUp(self):
        SECRETS.clear()
        SECRETS.update({"PROTOCOL_CHAOS_URL": self.url, "PROTOCOL_CHAOS_TOKEN": self.token})

    def protocol(self, event_id):
        return self.repo.call("event_get_protocol", {"eventId": event_id, "accounts": "all"}, 10)

    def loaded(self, host=None):
        host = host or NewHermes()
        self.plugin.register(host)
        plugin = host.hooks["pre_llm_call"].__self__
        self.addCleanup(plugin.close)
        return host, plugin

    # -- reading

    def test_overview_in_the_system_prompt_lists_open_matters_without_words(self):
        host, plugin = self.loaded()
        content, max_chars = host.sections["protocol-chaos.overview"]
        text = content({})
        self.assertLessEqual(len(text), max_chars)
        self.assertIn("2027 年春天葡萄牙行 · active · Looking at routes", text)
        self.assertIn("  - 2027 年葡萄牙行机票 · emerging", text)  # a part, under its parent
        self.assertNotIn("护照", text)  # done
        self.assertNotIn("evt_", text)
        self.assertNotIn("walk in Portugal", text)  # words stay out of the overview
        self.assertIn("Recording happens in the background", text)
        self.assertEqual(host.tasks, {"protocol_chaos_capture": "compression"})
        self.assertIn("organizer", host.skills)
        self.assertTrue(host.skills["organizer"].is_file())

    def test_a_message_that_names_a_matter_gets_its_details_once(self):
        host, plugin = self.loaded()
        result = plugin.pre_llm_call(session_id="s1", user_message="葡萄牙那趟要不要改成秋天？", conversation_history=[])
        context = result["context"]
        self.assertTrue(context.startswith(self.plugin.HEADER))
        self.assertIn(f"[id:{self.trip}]", context)
        self.assertIn("goal: Walk in Portugal with Mei in spring 2027.", context)
        self.assertIn("constraint: Under 20,000 yuan; stay near the old town.", context)
        self.assertIn("involves: Lisbon", context)
        self.assertIn(f"part of: 多出去走走 [id:{self.travel}]", context)
        self.assertIn(f"parts: 2027 年葡萄牙行机票 [id:{self.flights}]", context)
        self.assertIn("said ", context)
        self.assertLessEqual(len(context), 9500)
        # Shown once per session: the same message again adds nothing new.
        again = plugin.pre_llm_call(session_id="s1", user_message="葡萄牙那趟要不要改成秋天？", conversation_history=[])
        self.assertIsNone(again)
        # Nor in a new session that already holds it (a resumed conversation).
        resumed = plugin.pre_llm_call(session_id="s2", user_message="葡萄牙", conversation_history=[
            {"role": "user", "content": "x", "api_content": context}])
        self.assertIsNone(resumed)
        self.assertIsNone(plugin.pre_llm_call(session_id="s3", user_message="今天天气怎么样", conversation_history=[]))

    def test_the_server_never_receives_the_message(self):
        host, plugin = self.loaded()
        sent = []
        original = self.plugin.Repository._post

        def spy(repo, body, timeout, retry):
            sent.append(body.decode("utf-8"))
            return original(repo, body, timeout, retry)

        self.plugin.Repository._post = spy
        try:
            message = "葡萄牙机票我想等双十一再买，暗号 zx-7781"
            host.llm.decision = {"record": False}
            plugin.pre_llm_call(session_id="p1", user_message=message, conversation_history=[])
            plugin.capture(message)
        finally:
            self.plugin.Repository._post = original
        self.assertTrue(sent)
        self.assertTrue(all("zx-7781" not in body and "双十一" not in body for body in sent))
        tools = [json.loads(body)["params"]["name"] for body in sent]
        self.assertEqual(set(tools), {"context_pack", "event_get_protocol"})
        # The recording model saw it: that is the user's own model provider, through Hermes.
        self.assertIn("zx-7781", host.llm.calls[-1]["input"][0]["text"])

    # -- writing

    def test_background_recording_keeps_the_words_verbatim_on_the_picked_matter(self):
        host, plugin = self.loaded()
        message = "对了，葡萄牙机票我想等双十一再买。你觉得呢？"

        def decide(input):
            listed = input[0]["text"]
            ref = re.search(r"- (m\d+): 2027 年葡萄牙行机票", listed).group(1)
            return {"record": True, "ref": ref, "words": "葡萄牙机票我想等双十一再买。"}

        host.llm.decision = decide
        plugin.post_llm_call(session_id="w1", user_message=message, assistant_response="ok", conversation_history=[])
        for thread in plugin.threads:
            thread.join(10)
        words = [a["text"] for a in self.protocol(self.flights)["accounts"]]
        self.assertIn("葡萄牙机票我想等双十一再买。", words)
        accounts = self.protocol(self.flights)["accounts"]
        self.assertEqual(accounts[-1]["actor"], {"kind": "agent", "id": "hermes"})
        self.assertEqual(accounts[-1]["source"], "user")
        self.assertEqual(host.llm.calls[-1]["task"], "protocol_chaos_capture")

    def test_a_new_matter_starts_under_a_listed_parent_and_paraphrases_fall_back_to_the_message(self):
        host, plugin = self.loaded()
        message = "我打算明年夏天去日本看烟花大会"

        def decide(input):
            ref = re.search(r"- (m\d+): 多出去走走", input[0]["text"]).group(1)
            return {"record": True, "ref": None, "title": "2027 年夏天日本烟花大会", "parentRef": ref,
                    "words": "The user plans to see fireworks in Japan"}  # not the user's words

        host.llm.decision = decide
        receipt = plugin.capture(message)
        doc = self.protocol(receipt["eventId"])
        self.assertEqual(doc["event"]["title"], "2027 年夏天日本烟花大会")
        self.assertEqual(doc["event"]["parents"], [self.travel])
        self.assertEqual(doc["accounts"][0]["text"], message)

    def test_unlisted_refs_and_no_record(self):
        host, plugin = self.loaded()
        host.llm.decision = {"record": False}
        self.assertIsNone(plugin.capture("这顿饭多少卡路里"))
        host.llm.decision = {"record": True, "ref": "m999", "title": "2026 年秋天学烘焙", "parentRef": "evt_made_up"}
        receipt = plugin.capture("我想今年秋天学烘焙")
        doc = self.protocol(receipt["eventId"])
        self.assertEqual(doc["event"]["parents"], [])
        self.assertEqual(doc["event"]["title"], "2026 年秋天学烘焙")

    def test_scheduled_jobs_subagents_and_commands_get_nothing(self):
        host, plugin = self.loaded()
        self.assertIsNone(plugin.pre_llm_call(session_id="c1", user_message="葡萄牙", platform="cron"))
        self.assertIsNone(plugin.pre_llm_call(session_id="c2", user_message="葡萄牙", parent_session_id="x"))
        before = len(plugin.threads)
        plugin.post_llm_call(session_id="c1", user_message="葡萄牙机票要买了", platform="cron")
        plugin.post_llm_call(session_id="c3", user_message="/new")
        plugin.post_llm_call(session_id="c4", user_message="葡萄牙机票我买了", conversation_history=[
            {"role": "user", "content": "葡萄牙机票我买了"},
            {"role": "assistant", "tool_calls": [{"function": {"name": "mcp_protocol_chaos_event_note"}}]}])
        self.assertEqual(len(plugin.threads), before)

    # -- failure

    def test_an_unreachable_server_or_no_credentials_changes_nothing(self):
        host, plugin = self.loaded()
        SECRETS["PROTOCOL_CHAOS_URL"] = f"http://127.0.0.1:{free_port()}/mcp"
        started = time.time()
        self.assertIsNone(plugin.pre_llm_call(session_id="u1", user_message="葡萄牙", conversation_history=[]))
        self.assertEqual(host.sections["protocol-chaos.overview"][0]({}), "")
        self.assertIsNone(plugin.capture("葡萄牙机票我买了"))
        self.assertLess(time.time() - started, 10)
        SECRETS.clear()
        self.assertIsNone(plugin.pre_llm_call(session_id="u2", user_message="葡萄牙", conversation_history=[]))
        SECRETS.update({"PROTOCOL_CHAOS_URL": self.url, "PROTOCOL_CHAOS_TOKEN": "pc_wrong"})
        self.assertIsNone(plugin.pre_llm_call(session_id="u3", user_message="葡萄牙", conversation_history=[]))

    def test_old_hermes_gets_the_overview_in_the_first_turn_and_records_through_the_model(self):
        host = OldHermes()
        self.plugin.register(host)
        plugin = host.hooks["pre_llm_call"].__self__
        self.addCleanup(plugin.close)
        self.assertEqual(plugin.capture_mode, "model")
        first = plugin.pre_llm_call(session_id="o1", user_message="你好", conversation_history=[])["context"]
        self.assertIn(self.plugin.OVERVIEW_MARKER, first)
        self.assertIn("record them with one event_note", first)
        self.assertIsNone(plugin.pre_llm_call(session_id="o1", user_message="你好", conversation_history=[]))
        self.assertIsNone(host.hooks["post_llm_call"](session_id="o1", user_message="葡萄牙机票我买了"))

    def test_logs_never_hold_the_words(self):
        host, plugin = self.loaded()
        records = []
        handler = logging.Handler()
        handler.emit = lambda record: records.append(record.getMessage())
        logger = logging.getLogger("protocol_chaos")
        logger.addHandler(handler)
        logger.setLevel(logging.DEBUG)
        try:
            message = "装修预算我想压到十五万，暗号 qq-5512"
            host.llm.decision = lambda input: {
                "record": True, "ref": re.search(r"- (m\d+): 2026 年冬天装修", input[0]["text"]).group(1)}
            plugin.pre_llm_call(session_id="l1", user_message=message, conversation_history=[])
            plugin.capture(message)
        finally:
            logger.removeHandler(handler)
        self.assertTrue(records)
        self.assertTrue(all("qq-5512" not in line and "装修" not in line for line in records))

    def test_settings_and_the_capability_probe(self):
        host = NewHermes(settings={"actor": "mac-mini", "capture": "off", "overview": "bogus"})
        self.plugin.register(host)
        plugin = host.hooks["pre_llm_call"].__self__
        self.assertEqual(plugin.actor, "mac-mini")
        self.assertEqual(plugin.capture_mode, "off")
        self.assertEqual(plugin.settings["overview"], "auto")
        probe = RecordingContext()
        self.plugin.register(probe)
        manifest = (PLUGIN_DIR / "plugin.yaml").read_text(encoding="utf-8")
        block = re.split(r"\n(?=\S)", manifest.split("provides_hooks:")[1])[0]
        declared = re.findall(r"^  - (\w+)$", block, re.M)
        self.assertEqual(sorted(probe.hooks), sorted(declared))
        self.assertEqual(sorted(declared), ["post_llm_call", "pre_llm_call"])

    def test_no_bytecode_or_binaries_ship_with_the_plugin(self):
        # What Hermes installs is what the repository tracks (catalog rule 17).
        listed = subprocess.run(["git", "ls-files", "--others", "--cached", "--exclude-standard", str(PLUGIN_DIR)],
                                cwd=ROOT, capture_output=True, text=True)
        if listed.returncode != 0:
            self.skipTest("not a git checkout")
        for name in listed.stdout.split():
            self.assertNotIn(Path(name).suffix, (".pyc", ".pyo", ".so", ".dylib", ".dll", ".exe", ".wasm"), name)
            self.assertNotIn("__pycache__", name)


class HelperTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        install_secret_scope()
        cls.plugin = load_plugin()

    def test_tokens(self):
        t = self.plugin.tokens
        self.assertEqual(t("葡萄牙"), {"葡萄", "萄牙"})
        self.assertIn("lisbon", t("Trip to Lisbon!"))
        self.assertNotIn("我们", t("我们去葡萄牙"))
        self.assertIn("2027", t("2027 年"))

    def test_rank_prefers_rare_shared_words_and_skips_weak_ones(self):
        entries = [
            {"id": "a", "title": "2027 年春天葡萄牙行", "state": "active"},
            {"id": "b", "title": "2027 年买电车", "state": "emerging"},
            {"id": "c", "title": "2027 年换工作", "state": "active"},
            {"id": "d", "title": "葡萄牙语入门", "state": "done"},
        ]
        rank = self.plugin.rank
        # Shared with a closed matter too, which weighs less.
        self.assertEqual([e["id"] for e in rank("葡萄牙那趟改到秋天", entries, 1.0, 3)], ["a"])
        self.assertEqual([e["id"] for e in rank("葡萄牙那趟改到秋天", entries, 0.5, 3)], ["a", "d"])
        self.assertEqual(rank("2027 年", entries, 1.0, 3), [])  # common to most titles
        self.assertEqual(rank("hello", entries, 1.0, 3), [])
        self.assertEqual([e["id"] for e in rank("我想买个电车", entries, 1.0, 3)], ["b"])  # one rare word
        self.assertEqual(rank("葡萄牙", entries, 1.0, 3, exclude={"a"}), [])

    def test_forest_and_fit(self):
        entries = [{"id": "c", "parents": ["p"]}, {"id": "p", "parents": []}, {"id": "q", "parents": ["gone"]}]
        self.assertEqual([(d, e["id"]) for d, e in self.plugin.forest(entries)], [(0, "p"), (1, "c"), (0, "q")])
        text = self.plugin.fit_lines([f"line {i}" for i in range(100)], 120, "- … and {} more")
        self.assertLessEqual(len(text), 120)
        self.assertTrue(text.endswith("more"))

    def test_large_directories_stay_within_budget(self):
        entries = [{"id": f"evt_{i:04d}", "title": f"第 {i} 件很长的事情：" + "装修厨房和卫生间" * 6, "state": "active",
                    "parents": [f"evt_{i - 1:04d}"] if i % 3 else [], "progress": {"text": "进展" * 50, "timestamp": "x"}}
                   for i in range(400)]
        overview = self.plugin.overview_text(entries, 3900)
        self.assertLessEqual(len(overview), 3900)
        self.assertIn("more (context_pack lists every matter)", overview)
        listed, refs = self.plugin.candidate_list("第 7 件 卫生间", entries)
        self.assertLessEqual(len(listed), self.plugin.CAPTURE_LIST_CHARS)
        self.assertTrue(refs)
        self.assertTrue(all(ref in listed for ref in refs))

    def test_verbatim_words(self):
        v = self.plugin.verbatim_words
        self.assertEqual(v("机票等双十一", "对了，机票等双十一再买"), "机票等双十一")
        self.assertEqual(v("The user wants", "对了，机票等双十一再买"), "对了，机票等双十一再买")


if __name__ == "__main__":
    unittest.main()
