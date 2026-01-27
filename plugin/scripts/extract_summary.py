"""
Extract notification summary from Claude Code hook JSON.

Used by varie-avatar-notify (bash) and tested via pytest.
"""

import json
import os
import sys


def extract_bash_command(hook_json: str, max_length: int = 150) -> str:
    """Extract and normalize a Bash command from hook JSON.

    Handles JSON escaping (quoted strings, newlines, tabs, backslashes).
    Collapses whitespace for single-line display.
    """
    try:
        data = json.loads(hook_json)
        tool_input = data.get("tool_input", data)
        command = tool_input.get("command", "") if isinstance(tool_input, dict) else ""
        # Collapse newlines/tabs/excess whitespace into single spaces
        normalized = " ".join(command.split())
        return normalized[:max_length]
    except (json.JSONDecodeError, AttributeError):
        return ""


def extract_file_path(hook_json: str) -> str:
    """Extract basename of file_path from hook JSON (for Write/Edit tools)."""
    try:
        data = json.loads(hook_json)
        tool_input = data.get("tool_input", data)
        file_path = tool_input.get("file_path", "") if isinstance(tool_input, dict) else ""
        return os.path.basename(file_path) if file_path else ""
    except (json.JSONDecodeError, AttributeError):
        return ""


if __name__ == "__main__":
    # CLI mode: read JSON from stdin, extract field based on argv
    field = sys.argv[1] if len(sys.argv) > 1 else "command"
    stdin_data = sys.stdin.read()

    if field == "command":
        print(extract_bash_command(stdin_data))
    elif field == "file_path":
        print(extract_file_path(stdin_data))
