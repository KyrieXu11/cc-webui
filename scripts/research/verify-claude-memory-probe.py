#!/usr/bin/env python3
"""Verify and project memory-only fixtures from the offline Claude API probe."""
import argparse
import hashlib
import json
import re
from pathlib import Path


def text_blocks(messages):
    for message in messages:
        content = message.get("content", [])
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    yield block.get("text", "")


def project(captures: Path, fixtures: Path) -> dict:
    manifest = json.loads((captures / "probe-manifest.json").read_text())
    assert manifest["binary_sha256"] == "d8cb1e5c79684cc12a8bfc813e3a2073406921b6245744b3009be3ab5651d21e", "New binary: re-evaluate the version label and expected cases before generating these fixtures"
    cases = {case["case"]: case for case in manifest["cases"]}
    assert len(cases) == 6 and all(case["exit_code"] == 0 for case in cases.values())
    fixtures.mkdir(parents=True, exist_ok=True)
    results = []
    for file in sorted(captures.glob("request-*.json")):
        request = json.loads(file.read_text())
        if "/messages" not in request["path"] or "/count_tokens" in request["path"]:
            continue
        assert request.get("dummy_auth_verified") is True, "Need a capture whose fake server verified dummy authentication"
        case = request["case"]
        body = request["body"]
        system = "\n\n".join(block.get("text", "") for block in body["system"])
        texts = list(text_blocks(body.get("messages", [])))
        assert not any("PROBE_BODY_NOT_AUTO_INJECTED" in text for text in texts)
        match = re.search(r"(?m)^# (?:auto memory|Memory)\n", system)
        disabled = case.endswith("-disabled")
        if disabled:
            assert match is None
            assert not any("PROBE_INDEX" in text for text in texts)
            results.append({"case": case, "native_memory_disabled": True})
            continue
        assert match is not None
        end = system.find("\n# Environment", match.end())
        assert end > match.end()
        prompt = system[match.start():end].strip() + "\n"
        memory_dir = cases[case]["memory_dir"]
        normalized = prompt.replace(memory_dir, "<MEMORY_DIR>")
        assert memory_dir not in normalized
        name = case + ".txt"
        (fixtures / name).write_text(normalized)
        index = [text for text in texts if "PROBE_INDEX" in text]
        assert index
        if case.endswith("-resume"):
            assert "PROBE_INDEX_v2" in index[-1]
            assert "supersede" in index[-1] or "re-read" in index[-1]
        else:
            assert "PROBE_INDEX_v1" in index[-1]
        index_name = case + "-index.txt"
        normalized_index = index[-1].replace(memory_dir, "<MEMORY_DIR>")
        (fixtures / index_name).write_text(normalized_index + "\n")
        if "sonnet" in case:
            assert normalized.count("<when_to_save>") == 4
            assert "## When to access memories" in normalized
            assert "find and remove the relevant entry" in normalized
        else:
            assert "delete memories that turn out to be wrong" in normalized
        results.append({
            "case": case, "file": name, "index_file": index_name,
            "raw_prompt_js_units": len(prompt.encode("utf-16-le")) // 2,
            "normalized_sha256": hashlib.sha256(normalized.encode()).hexdigest(),
            "only_index_auto_injected": True,
        })
    assert len(results) == 6
    summary = {
        "version": "2.1.283", "capture_date": "2026-10-03",
        "binary_sha256": manifest["binary_sha256"],
        "network": "macOS sandbox allows localhost outbound only; fake API and dummy key",
        "scope": "isolated HOME/config/workspace; normal print-mode file-memory branch",
        "normalization": "Only the synthetic memory directory is replaced with <MEMORY_DIR>; other prompt wording is unchanged",
        "cases": results,
    }
    (fixtures / "capture-summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    return summary


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("captures", type=Path)
    parser.add_argument("fixtures", type=Path)
    args = parser.parse_args()
    print(json.dumps(project(args.captures, args.fixtures), ensure_ascii=False, indent=2))
