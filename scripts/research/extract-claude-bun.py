#!/usr/bin/env python3
"""Read-only extraction of source text from a local Bun Mach-O executable.

Does not execute, patch, or redistribute the executable. Keep extracted modules
in a private research directory, not the repository. Supports the 52-byte module
record used by the inspected Claude Code 2.1.283 binary; rejects unknown layouts.
Format reference: oven-sh/bun/src/standalone_graph/StandaloneModuleGraph.rs.
"""
import argparse
import hashlib
import json
import re
import struct
from pathlib import Path


def bun_section(binary: bytes) -> tuple[int, int]:
    if struct.unpack_from("<I", binary)[0] != 0xFEEDFACF:
        raise ValueError("Expected little-endian 64-bit Mach-O")
    commands = struct.unpack_from("<I", binary, 16)[0]
    cursor = 32
    for _ in range(commands):
        command, size = struct.unpack_from("<II", binary, cursor)
        if size < 8 or cursor + size > len(binary):
            raise ValueError("Invalid Mach-O command")
        if command == 0x19:
            section_count = struct.unpack_from("<I", binary, cursor + 64)[0]
            for index in range(section_count):
                section = cursor + 72 + index * 80
                if section + 80 > cursor + size:
                    raise ValueError("Invalid Mach-O section table")
                name = binary[section:section + 16].rstrip(b"\0")
                segment = binary[section + 16:section + 32].rstrip(b"\0")
                if name == b"__bun" and segment == b"__BUN":
                    length = struct.unpack_from("<Q", binary, section + 40)[0]
                    offset = struct.unpack_from("<I", binary, section + 48)[0]
                    if offset + length > len(binary):
                        raise ValueError("Bun section exceeds executable")
                    return offset, length
        cursor += size
    raise ValueError("No __BUN/__bun section")


def extract(binary_path: Path, destination: Path) -> dict:
    binary = binary_path.read_bytes()
    offset, length = bun_section(binary)
    section = binary[offset:offset + length]
    payload_length = struct.unpack_from("<Q", section)[0]
    if payload_length != len(section) - 8:
        raise ValueError("Unknown Bun section wrapper")
    graph = section[8:]
    trailer = b"\n---- Bun! ----\n"
    if not graph.endswith(trailer):
        raise ValueError("Missing Bun graph trailer")
    byte_count, modules_offset, modules_length, entry_point, argv_offset, argv_length, flags = struct.unpack(
        "<QIIIIII", graph[-len(trailer) - 32:-len(trailer)]
    )
    if byte_count > len(graph) - 32 - len(trailer) or modules_offset + modules_length > byte_count or modules_length % 52:
        raise ValueError("Unknown Bun module table layout")

    def pointed(start: int, size: int) -> bytes:
        if start + size > byte_count:
            raise ValueError("Module pointer out of bounds")
        return graph[start:start + size]

    if destination.exists() and any(destination.iterdir()):
        raise ValueError("Destination must be empty; refusing to overwrite research")
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    modules_dir = destination / "modules"
    modules_dir.mkdir(mode=0o700)
    modules = []
    for index in range(modules_length // 52):
        fields = struct.unpack_from("<12I4B", graph, modules_offset + index * 52)
        name = pointed(*fields[:2]).decode("utf-8")
        contents = pointed(*fields[2:4])
        encoding = fields[12]
        source = None
        if encoding == 1:
            source = contents.decode("latin-1")
        elif encoding == 2:
            source = contents.decode("utf-16-le")
        local = None
        if source is not None:
            basename = re.sub(r"[^A-Za-z0-9_.-]", "_", name.rsplit("/", 1)[-1]) or "module"
            local = f"modules/{index:04d}-{basename}.txt"
            target = destination / local
            target.write_text(source, encoding="utf-8")
            target.chmod(0o600)
        modules.append({
            "index": index, "name": name, "file": local,
            "encoding": encoding, "loader": fields[13], "module_format": fields[14],
            "contents_offset": fields[2], "contents_length": fields[3],
            "binary_contents_offset": offset + 8 + fields[2],
            "contents_sha256": hashlib.sha256(contents).hexdigest(),
        })
    metadata = {
        "binary": str(binary_path.resolve()),
        "binary_sha256": hashlib.sha256(binary).hexdigest(),
        "section_offset": offset, "section_length": length,
        "entry_point": entry_point, "flags": flags,
        "module_count": len(modules), "text_module_count": sum(m["file"] is not None for m in modules),
        "modules": modules,
    }
    manifest = destination / "manifest.json"
    manifest.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n")
    manifest.chmod(0o600)
    return metadata


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    metadata = extract(args.binary, args.destination)
    print(json.dumps({k: v for k, v in metadata.items() if k != "modules"}, indent=2))
