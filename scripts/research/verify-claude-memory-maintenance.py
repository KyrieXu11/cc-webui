#!/usr/bin/env python3
"""Verify the isolated native maintenance probe and project memory-only evidence.

Never publishes whole API requests or vendor system prompts. The binary hash,
case matrix and fixed synthetic replies are specific to Claude Code 2.1.283.
"""
import argparse
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path

EXPECTED = {
    "baseline_off": (0, 0),
    "extract_on": (1, 0),
    "headless_gate_off": (0, 0),
    "cadence_two": (0, 0),
    "no_user_prose": (0, 0),
    "native_disabled": (0, 0),
    "direct_write": (0, 0),
    "failed_direct_edit": (0, 0),
    "extract_write_guard": (2, 0),
    "extract_update_existing": (3, 0),
    "dream_print_sdk": (0, 0),
    "extract_turn_limit": (5, 0),
    "dream_forced_desktop": (0, 1),
    "dream_time_gate": (0, 0),
    "dream_sessions_gate": (0, 0),
    "dream_live_lock": (0, 0),
    "dream_write_guard": (0, 2),
    "dream_update_existing": (0, 3),
    "dream_turn_limit": (0, 50),
    "dream_setting_off": (0, 0),
    "dream_unavailable": (0, 0),
    "dream_available_opt_in": (0, 1),
    "extract_stale_notice": (4, 0),
    "dream_stale_notice": (0, 3),
}
BINARY_HASH = "d8cb1e5c79684cc12a8bfc813e3a2073406921b6245744b3009be3ab5651d21e"


def text_blocks(body):
    for message in body.get("messages", []):
        content = message.get("content", [])
        if isinstance(content, str):
            yield content
        elif isinstance(content, list):
            for block in content:
                if block.get("type") == "text":
                    yield block.get("text", "")


def tool_errors(records, tool_id):
    for record in records:
        for message in record["body"].get("messages", []):
            content = message.get("content", [])
            if not isinstance(content, list):
                continue
            for block in content:
                if block.get("type") == "tool_result" and block.get("tool_use_id") == tool_id and block.get("is_error") is True:
                    yield block


def project(captures: Path, fixtures: Path):
    manifest = json.loads((captures / "probe-summary.json").read_text())
    assert manifest["version"] == "2.1.283"
    assert manifest["binary_sha256"] == BINARY_HASH
    assert manifest["production_modified"] is False
    assert manifest["real_model_called"] is False
    cases = {case["case"]: case for case in manifest["cases"]}
    assert set(cases) == set(EXPECTED), "Need the complete reviewed matrix"
    records = []
    for path in sorted(captures.glob("request-*.json")):
        record = json.loads(path.read_text())
        assert record["dummy_auth_verified"] is True
        records.append(record)
    for name, (extract, dream) in EXPECTED.items():
        case = cases[name]
        assert case["exit_code"] == 0, name
        assert not case["outside_written"], name
        assert case["counts"].get("extract", 0) == extract, name
        assert case["counts"].get("dream", 0) == dream, name
        if extract or dream:
            assert case["background_system_text_matches_main"] is True, name
            assert case["background_tool_names_match_main"] is True, name
    assert cases["direct_write"]["main_body_changed"] is True
    assert cases["failed_direct_edit"]["main_body_changed"] is False
    assert list(tool_errors([r for r in records if r["case"] == "failed_direct_edit"], "tool_main_failed"))
    for name in ["extract_write_guard", "dream_write_guard"]:
        assert list(tool_errors([r for r in records if r["case"] == name], "tool_bg_outside")), name
    for name in ["extract_update_existing", "dream_update_existing", "extract_stale_notice", "dream_stale_notice"]:
        assert cases[name]["background_body_changed"] is True, name
    for name in ["extract_stale_notice", "dream_stale_notice"]:
        assert cases[name]["stale_notice_seen"] is True, name
    assert cases["dream_forced_desktop"]["lock_age_seconds_after"] < 10
    assert cases["dream_print_sdk"]["lock_age_seconds_after"] > 47 * 3600

    fixtures.mkdir(parents=True, exist_ok=True)
    projected = []
    for case, phase, prefix, filename in [
        ("extract_on", "extract", "You are now acting as the memory extraction subagent.", "background-extraction-request.txt"),
        ("dream_forced_desktop", "dream", "# Dream: Memory Consolidation", "autodream-request.txt"),
    ]:
        request = next(r for r in records if r["case"] == case and r["phase"] == phase)
        prompt = next(text for text in text_blocks(request["body"]) if text.startswith(prefix))
        memory = re.search(r"Memory directory: `([^`]+)`", prompt)
        transcripts = re.search(r"Session transcripts: `([^`]+)`", prompt)
        if memory:
            prompt = prompt.replace(memory.group(1), "<MEMORY_DIR>")
        if transcripts:
            prompt = prompt.replace(transcripts.group(1), "<TRANSCRIPTS_DIR>")
        prompt = re.sub(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z", "<TIMESTAMP>", prompt)
        prompt = re.sub(r"\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b", "<SESSION_ID>", prompt)
        assert "/private/var/folders/" not in prompt and "/Users/" not in prompt
        assert "sk-ant-" not in prompt
        text = prompt.strip() + "\n"
        (fixtures / filename).write_text(text)
        projected.append({"file": filename, "case": case, "sha256": hashlib.sha256(text.encode()).hexdigest()})
    summary = {
        **manifest,
        "verified_date": datetime.now(timezone.utc).date().isoformat(),
        "verified_cases": len(cases),
        "raw_api_request_count_including_seed_and_title": len(records),
        "autodream_probe_conditions": "Synthetic cached gates and claude-desktop entrypoint; not a normal sdk-cli rollout test",
        "normalization": "Only synthetic memory/transcript paths, ISO timestamps and session UUIDs in the memory-specific user prompts are replaced",
        "fixtures": projected,
        "limits": "Verifies native scheduling, request construction, tools and update notification; deterministic fake replies do not measure real model recall or merge quality",
    }
    (fixtures / "maintenance-capture-summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    return {"verified_cases": len(cases), "fixtures": projected}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("captures", type=Path)
    parser.add_argument("fixtures", type=Path)
    args = parser.parse_args()
    print(json.dumps(project(args.captures, args.fixtures), ensure_ascii=False, indent=2))
