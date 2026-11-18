"""Run one deadline reminder pass from the command line or an operating-system scheduler.

Access to the database settings (MongoDB connection string) is the authentication here: the command opens no network port.

    python backend/tools/process_reminders.py             Send everything that is due now
    python backend/tools/process_reminders.py --dry-run   List what is due, without sending
    python backend/tools/process_reminders.py --dry-run --now 2026-11-08T12:30:00Z   ...as of another time

Uses the LMS MongoDB database (LMS_MONGODB_DB, otherwise the configured database; see src/store.py).
Safe to run repeatedly or alongside the server.
The exit code is 1 when a reminder or an employee failed; failed reminders are retried on later passes.
"""
import argparse
import json
import sys
from contextlib import closing
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from database import connect, initialize
from deadlines import parse_utc
import reminders
import store


def main():
    parser = argparse.ArgumentParser(description='Process ShimentoX course deadline reminders once.')
    parser.add_argument('--dry-run', action='store_true', help='List what is due without sending or recording anything')
    parser.add_argument('--now', help='With --dry-run: evaluate at this ISO timestamp instead of the current time')
    args = parser.parse_args()
    if args.now and not args.dry_run:
        parser.error('--now requires --dry-run, because real reminders must use the real time.')
    path = store.settings()['database']
    # A database the portal has never initialized has no reminder settings (the former "database file not found").
    with closing(connect(path)) as db:
        found = db['reminder_settings'].exists({'id': 1})
    if not found:
        parser.error(f'Database not found: {path}')
    # MongoDB has no schema version to compare (the former PRAGMA user_version check); initialization is idempotent
    # and brings the collections, indexes and packaged data up to date, as an upgrade did.
    initialize(path)
    if args.dry_run:
        at = parse_utc(args.now) if args.now else None
        print(json.dumps({'due': reminders.preview(path, at)}, indent=2))
        return 0
    summary = reminders.run_pass(path)
    print(json.dumps(summary))
    return 1 if summary['failed'] or summary['errors'] else 0


if __name__ == '__main__':
    sys.exit(main())
