from __future__ import annotations

import sqlite3
import unittest
from pathlib import Path


MIGRATIONS = Path(__file__).resolve().parents[1] / "migrations"


class SegmentVectorMigrationTests(unittest.TestCase):
    def test_triggers_track_insert_reindex_and_delete(self) -> None:
        connection = sqlite3.connect(":memory:")
        self.addCleanup(connection.close)
        for name in ("0001_init.sql", "0002_project_isolation.sql", "0004_memory_retention.sql", "0023_segment_vector_reconciliation.sql"):
            connection.executescript((MIGRATIONS / name).read_text(encoding="utf-8"))

        connection.execute(
            "INSERT INTO memory_segments (id, project_id, text, content_hash, metadata_json, created_at, updated_at, deletion_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            ("seg-1", "project-1", "one", "hash-1", "{}", 1, 10, "active"),
        )
        connection.execute(
            "UPDATE memory_segment_vector_jobs SET status = 'processing', lease_token = 'lease-1', operation_token = 'request-1' WHERE segment_id = 'seg-1'",
        )
        connection.execute("UPDATE memory_segments SET text = 'two', updated_at = 20 WHERE id = 'seg-1'")
        connection.execute("UPDATE memory_segments SET deletion_state = 'pending_delete', updated_at = 30 WHERE id = 'seg-1'")
        connection.execute("DELETE FROM memory_segments WHERE id = 'seg-1'")

        row = connection.execute(
            "SELECT revision, operation, segment_updated_at, status, lease_token, operation_token FROM memory_segment_vector_jobs WHERE project_id = ? AND segment_id = ?",
            ("project-1", "seg-1"),
        ).fetchone()
        self.assertEqual(row, (4, "delete", 30, "processing", "lease-1", None))


if __name__ == "__main__":
    unittest.main()
