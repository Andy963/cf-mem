from __future__ import annotations

import sqlite3
import unittest
from pathlib import Path


MIGRATIONS = Path(__file__).resolve().parents[1] / "migrations"


class AdminAuditMigrationTests(unittest.TestCase):
    def test_delete_audit_migration_preserves_existing_history(self) -> None:
        connection = sqlite3.connect(":memory:")
        self.addCleanup(connection.close)
        connection.executescript(
            (MIGRATIONS / "0003_durable_memory.sql").read_text(encoding="utf-8")
        )
        connection.executescript(
            (MIGRATIONS / "0011_admin_claim_management.sql").read_text(encoding="utf-8")
        )
        connection.execute(
            """
            INSERT INTO memory_claim_audit_log (
              id, project_id, claim_id, action, actor_email, reason, before_json, after_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "audit-edit",
                "project-1",
                "claim-1",
                "edit",
                "admin@example.com",
                None,
                None,
                None,
                1,
            ),
        )

        connection.executescript(
            (MIGRATIONS / "0022_admin_claim_delete_audit.sql").read_text(encoding="utf-8")
        )
        connection.execute(
            """
            INSERT INTO memory_claim_audit_log (
              id, project_id, claim_id, action, actor_email, reason, before_json, after_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "audit-delete",
                "project-1",
                "claim-1",
                "delete",
                "admin@example.com",
                "cleanup",
                "{}",
                None,
                2,
            ),
        )

        rows = connection.execute(
            """
            SELECT action FROM memory_claim_audit_log
            WHERE project_id = ? AND claim_id = ?
            ORDER BY created_at
            """,
            ("project-1", "claim-1"),
        ).fetchall()
        self.assertEqual(rows, [("edit",), ("delete",)])
        mutation_token = connection.execute(
            "SELECT mutation_token FROM memory_claims LIMIT 1"
        ).fetchone()
        self.assertIsNone(mutation_token)


if __name__ == "__main__":
    unittest.main()
