from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock


HOOK_PATH = Path(__file__).resolve().parents[1] / "scripts" / "cf_mem_hook.py"
SPEC = importlib.util.spec_from_file_location("cf_mem_hook", HOOK_PATH)
assert SPEC is not None and SPEC.loader is not None
cf_mem_hook = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cf_mem_hook)


class ProjectResolutionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)

    def _create_repository(self, name: str) -> Path:
        repository = Path(self.temp_dir.name) / name
        repository.mkdir()
        subprocess.run(["git", "init", "-q", str(repository)], check=True)
        return repository

    def test_uses_valid_configured_override_without_workspace(self) -> None:
        config = {"project_id": "configured-project"}
        self.assertEqual(cf_mem_hook._resolve_project_id(config, None), "configured-project")

    def test_uses_environment_override_when_configured_value_is_legacy(self) -> None:
        with mock.patch.dict(os.environ, {"CF_MEM_PROJECT_ID": "environment-project"}):
            self.assertEqual(
                cf_mem_hook._resolve_project_id({"project_id": "personal"}, None),
                "environment-project",
            )

    def test_rejects_invalid_override_instead_of_deriving_fallback(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertIsNone(
                cf_mem_hook._resolve_project_id({"project_id": "invalid project"}, None)
            )
            self.assertIsNone(
                cf_mem_hook._resolve_project_id({"project_id": "x" * 33}, None)
            )

    def test_derives_project_from_repository_when_legacy_values_are_present(self) -> None:
        repository = self._create_repository("derived-project")
        with mock.patch.dict(os.environ, {"CF_MEM_PROJECT_ID": "personal"}):
            self.assertEqual(
                cf_mem_hook._resolve_project_id({"project_id": "personal"}, str(repository)),
                "derived-project",
            )

    def test_missing_workspace_without_override_fails_closed(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertIsNone(cf_mem_hook._resolve_project_id({}, None))

    def test_linked_worktree_resolves_to_main_repository_name(self) -> None:
        repository = self._create_repository("main-project")
        (repository / "tracked.txt").write_text("content\n", encoding="utf-8")
        subprocess.run(["git", "-C", str(repository), "add", "tracked.txt"], check=True)
        subprocess.run(
            [
                "git",
                "-C",
                str(repository),
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "-qm",
                "initial",
            ],
            check=True,
        )
        worktree = Path(self.temp_dir.name) / "linked-worktree"
        subprocess.run(
            ["git", "-C", str(repository), "worktree", "add", "-qb", "linked", str(worktree)],
            check=True,
        )
        self.addCleanup(
            subprocess.run,
            ["git", "-C", str(repository), "worktree", "remove", "--force", str(worktree)],
        )

        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(
                cf_mem_hook._resolve_project_id({}, str(worktree)),
                "main-project",
            )


class RequestRoutingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        temp_roots_patcher = mock.patch.object(cf_mem_hook, "_TEMP_ROOTS", frozenset())
        temp_roots_patcher.start()
        self.addCleanup(temp_roots_patcher.stop)
        self.repository = Path(self.temp_dir.name) / "request-project"
        self.repository.mkdir()
        subprocess.run(["git", "init", "-q", str(self.repository)], check=True)
        self.config = {
            "base_url": "https://example.test/memory",
            "token": "test-token",
            "owner_id": "owner",
            "project_id": "personal",
        }
        self.payload = {
            "workspace_root": str(self.repository),
            "prompt": "A durable project statement.",
            "assistant_response": "A durable assistant statement.",
        }

    def test_capture_uses_repository_project_header(self) -> None:
        with (
            mock.patch.object(cf_mem_hook, "_read_stdin_payload", return_value=self.payload),
            mock.patch.object(cf_mem_hook, "_load_config", return_value=self.config),
            mock.patch.object(cf_mem_hook, "_record_prompt", return_value=False),
            mock.patch.object(cf_mem_hook, "_http_post") as http_post,
        ):
            self.assertEqual(cf_mem_hook.handle_capture("codex"), 0)

        self.assertEqual(http_post.call_args.args[3], "request-project")

    def test_context_uses_repository_project_header(self) -> None:
        with (
            mock.patch.object(cf_mem_hook, "_read_stdin_payload", return_value=self.payload),
            mock.patch.object(cf_mem_hook, "_load_config", return_value=self.config),
            mock.patch.object(cf_mem_hook, "_http_get", return_value={}) as http_get,
            mock.patch.object(cf_mem_hook, "_reset_prompt_counter"),
            mock.patch.object(cf_mem_hook, "_context_response"),
        ):
            self.assertEqual(cf_mem_hook.handle_context("codex"), 0)

        self.assertEqual(http_get.call_args.args[2], "request-project")
        self.assertIn("workspace_id=ws_request-project_", http_get.call_args.args[0])

    def test_assistant_capture_uses_repository_project_header(self) -> None:
        with (
            mock.patch.object(cf_mem_hook, "_read_stdin_payload", return_value=self.payload),
            mock.patch.object(cf_mem_hook, "_load_config", return_value=self.config),
            mock.patch.object(cf_mem_hook, "_http_post") as http_post,
        ):
            self.assertEqual(cf_mem_hook.handle_assistant_capture("codex"), 0)

        body = http_post.call_args.args[2]
        self.assertEqual(http_post.call_args.args[3], "request-project")
        self.assertEqual(json.loads(json.dumps(body))["workspace_name"], "request-project")

    def test_all_request_paths_fail_closed_before_network(self) -> None:
        payload = {"prompt": "A durable project statement."}
        with (
            mock.patch.object(cf_mem_hook, "_read_stdin_payload", return_value=payload),
            mock.patch.object(cf_mem_hook, "_load_config", return_value=self.config),
            mock.patch.object(cf_mem_hook, "_record_prompt", return_value=False),
            mock.patch.object(cf_mem_hook, "_http_get") as http_get,
            mock.patch.object(cf_mem_hook, "_http_post") as http_post,
        ):
            self.assertEqual(cf_mem_hook.handle_capture("codex"), 0)
            self.assertEqual(cf_mem_hook.handle_context("codex"), 0)
            self.assertEqual(cf_mem_hook.handle_assistant_capture("codex"), 0)

        http_get.assert_not_called()
        http_post.assert_not_called()


if __name__ == "__main__":
    unittest.main()
