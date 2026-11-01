"""Normalize visible text without discarding raw captures used for terminal safety checks."""
import re

_CSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")


def plain_terminal_text(data: bytes | bytearray) -> str:
    return _CSI.sub("", data.decode("utf-8", errors="replace"))
