"""Tests for notification summary extraction from Claude Code hook JSON.

Tests the Python extraction logic used by plugin/scripts/varie-avatar-notify
to build notification summaries for the daemon overlay.

Run: cd varie-claude-avatar && python3 -m pytest tests/ -v
"""

import json
import sys
import os

# Add scripts dir to path so we can import extract_summary
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "plugin", "scripts"))

from extract_summary import extract_bash_command, extract_file_path


def _hook_json(tool: str, tool_input: dict) -> str:
    """Build a minimal Claude Code hook JSON payload."""
    return json.dumps({
        "tool_name": tool,
        "tool_input": tool_input,
        "session_id": "test-session",
    })


# ── Bash command extraction ──────────────────────────────────────────


class TestBashCommandExtraction:
    """Tests for extract_bash_command()."""

    def test_simple_command(self):
        data = _hook_json("Bash", {"command": "ls -la"})
        assert extract_bash_command(data) == "ls -la"

    def test_command_with_quoted_url(self):
        """Issue 007: curl with quoted URL was truncated to 'curl -s \\'."""
        cmd = 'curl -s "https://varie.ai/api/character-create/public/discover?limit=20"'
        data = _hook_json("Bash", {"command": cmd})
        assert extract_bash_command(data) == cmd

    def test_command_with_single_quotes(self):
        cmd = "echo 'hello world'"
        data = _hook_json("Bash", {"command": cmd})
        assert extract_bash_command(data) == cmd

    def test_multiline_command_collapsed(self):
        """Multi-line commands should be collapsed to single line."""
        cmd = "git add . &&\ngit commit -m \"fix bug\""
        data = _hook_json("Bash", {"command": cmd})
        result = extract_bash_command(data)
        assert "\n" not in result
        assert result == 'git add . && git commit -m "fix bug"'

    def test_command_with_tabs_collapsed(self):
        cmd = "echo\t\thello\tworld"
        data = _hook_json("Bash", {"command": cmd})
        assert extract_bash_command(data) == "echo hello world"

    def test_long_command_truncated(self):
        cmd = "echo " + "a" * 200
        data = _hook_json("Bash", {"command": cmd})
        result = extract_bash_command(data)
        assert len(result) == 150

    def test_empty_command(self):
        data = _hook_json("Bash", {"command": ""})
        assert extract_bash_command(data) == ""

    def test_command_with_backslashes(self):
        cmd = 'grep -r "pattern" /path/to/dir\\ with\\ spaces'
        data = _hook_json("Bash", {"command": cmd})
        assert extract_bash_command(data) == cmd

    def test_command_with_pipe_and_redirect(self):
        cmd = 'cat file.txt | grep "error" > output.log 2>&1'
        data = _hook_json("Bash", {"command": cmd})
        assert extract_bash_command(data) == cmd

    def test_git_commit_with_message(self):
        cmd = 'git commit -m "feat: add new feature"'
        data = _hook_json("Bash", {"command": cmd})
        assert extract_bash_command(data) == cmd

    def test_invalid_json(self):
        assert extract_bash_command("not valid json") == ""

    def test_missing_tool_input(self):
        data = json.dumps({"tool_name": "Bash"})
        assert extract_bash_command(data) == ""

    def test_missing_command_field(self):
        data = _hook_json("Bash", {"description": "some desc"})
        assert extract_bash_command(data) == ""


# ── File path extraction ─────────────────────────────────────────────


class TestFilePathExtraction:
    """Tests for extract_file_path()."""

    def test_simple_path(self):
        data = _hook_json("Write", {"file_path": "/Users/me/project/src/index.ts"})
        assert extract_file_path(data) == "index.ts"

    def test_nested_path(self):
        data = _hook_json("Edit", {"file_path": "/a/b/c/d/component.tsx"})
        assert extract_file_path(data) == "component.tsx"

    def test_empty_path(self):
        data = _hook_json("Write", {"file_path": ""})
        assert extract_file_path(data) == ""

    def test_missing_file_path(self):
        data = _hook_json("Edit", {"old_string": "foo", "new_string": "bar"})
        assert extract_file_path(data) == ""

    def test_invalid_json(self):
        assert extract_file_path("{bad json") == ""
