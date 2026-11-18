"""MongoDB schema initialization, curriculum seed, and transactional connections.

The collections and indexes come from store.ensure_schema() (generated from the former SQLite schema), so the SQLite
structural migrations (schema versions, migration scripts, table rebuilds, added columns) are no longer needed: a
MongoDB database always starts at the current structure. Every data step of initialization is kept and stays idempotent.
Seeding batches its reads and writes, because every MongoDB round trip costs far more than a SQLite statement did.
"""
import hashlib
import json
import secrets
import uuid
from datetime import datetime, timezone
from pathlib import Path

from pymongo import UpdateOne

import store
from deadlines import end_of_day

BACKEND = Path(__file__).resolve().parents[1]
COURSE_ID = 'python-programming'
# The schema version the data corresponds to (the former SQLite PRAGMA user_version), kept for reference.
SCHEMA_VERSION = 13
GENAI_COURSE = BACKEND / 'data/generative-ai-course.json'
RAG_COURSE = BACKEND / 'data/rag-course.json'
POSH_COURSE = BACKEND / 'data/posh-course.json'
PHISHING_COURSE = BACKEND / 'data/phishing-cybersecurity-awareness-course.json'
AGILE_COURSE = BACKEND / 'data/agile-scrum-course.json'
DATA_PRIVACY_COURSE = BACKEND / 'data/data-privacy-course.json'
ADMIN_SEED = BACKEND / 'data/admin-seed.json'
# Exam security rule for every scored attempt: no more than three attempts (module exams, assignments, knowledge checks and assessments).
MAX_EXAM_ATTEMPTS = 3
PYTHON_PATH = BACKEND / 'data/shimento-python-course.json'
JAVA_PATH = BACKEND / 'data/java-full-stack-course.json'
VIDEO_ROOT = BACKEND / 'videos'
DEFAULT_DEPARTMENTS =['Engineering', 'Human Resources', 'Sales', 'Marketing', 'Finance']
DEFAULT_CATEGORIES = ['Technical Skills', 'Generative AI & Automation', 'Data Analytics', 'Communication & Presentation', 'Leadership & Management', 'Cybersecurity Awareness', 'Cybersecurity and Data Protection', 'Policies & Compliance', 'Professional Development']
CURRICULUM = json.loads((BACKEND / 'data/python-course.json').read_text(encoding='utf-8'))
LESSONS = json.loads((BACKEND / 'data/python-lessons.json').read_text(encoding='utf-8'))


def connect(target=None):
    """A transactional connection to the LMS database. target: None/'' for the configured database, or a former
    SQLite file path (tests), which maps to its own throwaway database."""
    return store.connect(target)


def initialize(target=None):
    schema = store.connect(target, transactional=False)
    try:
        # Collections and indexes (including the certificate number/token uniques) are created outside the transaction.
        schema.ensure_schema()
    finally:
        schema.close()
    db = connect(target)
    try:
        # Number certificates that have no public number yet.
        for row in db['certificates'].find({'certificate_number': {'$in': [None, '']}}, ['id']):
            while True:
                number = 'SX-' + secrets.token_hex(6).upper()
                if not db['certificates'].exists({'certificate_number': number}):
                    db['certificates'].update({'id': row['id']}, {'certificate_number': number})
                    break
        # Date-only deadlines become the end of that day, which is when they already became overdue.
        for row in db['course_assignments'].find({'due_date': {'$ne': None}, 'deadline_at': None}, ['id', 'due_date']):
            exact = end_of_day(row['due_date'])
            db['course_assignments'].update({'id': row['id']}, {'deadline_at': exact, 'original_deadline_at': exact})
        db['reminder_settings'].upsert({'id': 1}, {})
        # The learning activity backfill only converted history from SQLite files older than schema version 12; a
        # MongoDB database starts with the current structure, so there is never anything to backfill.
        stamp = datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        db.deleted_courses = set(db['deleted_courses'].distinct('course_id'))
        # Configurable defaults are seeded once, only into empty tables, so admin deletions are respected.
        if not db['departments'].exists():
            db['departments'].insert_many([{'id': str(uuid.uuid4()), 'name': name, 'created_at': stamp} for name in DEFAULT_DEPARTMENTS])
        db['courses'].upsert({'id': COURSE_ID}, {}, insert_only={'title': 'PYTHON PROGRAMMING', 'version': 1})
        if not db['course_categories'].exists():
            names, seen = [], set()
            for name in DEFAULT_CATEGORIES + db['courses'].distinct('category'):
                if name.casefold() not in seen:  # INSERT OR IGNORE on a case-insensitive key
                    seen.add(name.casefold())
                    names.append(name)
            db['course_categories'].insert_many([{'name': name, 'created_at': stamp} for name in names])
        db['courses'].update({'id': COURSE_ID, 'lessons_json': '[]'},
                             {'lessons_json': json.dumps(LESSONS), 'sets_json': json.dumps(CURRICULUM), 'description': 'Build a strong foundation in Python, one lesson at a time.'})
        sets, videos, questions = [], [], []
        for s, item in enumerate(CURRICULUM):
            sets.append({'course_id': COURSE_ID, 'set_index': s, 'title': item['title']})
            for video in item['videos']:
                videos.append({'course_id': COURSE_ID, 'video_index': video, 'set_index': s, 'duration_seconds': 48})
            groups = [('exam', -1, item['exam'])] + [('exercise', e, exercise['questions']) for e, exercise in enumerate(item['exercises'])]
            for kind, exercise, group in groups:
                for i, q in enumerate(group):
                    questions.append({'course_id': COURSE_ID, 'set_index': s, 'kind': kind, 'exercise_index': exercise, 'question_index': i,
                                      'prompt': q[0], 'options_json': json.dumps(q[1]), 'correct_option': q[2], 'explanation': q[3] if len(q) > 3 else ''})
        insert_missing(db, 'course_sets', sets, {'course_id': COURSE_ID})
        insert_missing(db, 'videos', videos, {'course_id': COURSE_ID})
        insert_missing(db, 'assessment_questions', questions, {'course_id': COURSE_ID})
        seed_lesson_course(db, GENAI_COURSE, stamp)
        seed_lesson_course(db, RAG_COURSE, stamp)
        seed_lesson_course(db, POSH_COURSE, stamp)
        seed_lesson_course(db, PHISHING_COURSE, stamp)
        seed_lesson_course(db, AGILE_COURSE, stamp)
        seed_lesson_course(db, DATA_PRIVACY_COURSE, stamp)
        seed_lesson_course(db, PYTHON_PATH, stamp)
        # Rename the packaged course in existing installs without changing its ID or learner history.
        db['courses'].update({'id': 'shimento-python-developer', 'title': 'Python Developer — Shimento'}, {'title': 'Python Programming Senior'})
        seed_checkpoints(db, PYTHON_PATH)
        upgrade_python_interactive(db, PYTHON_PATH, stamp)
        upgrade_python_lessons(db, PYTHON_PATH, stamp)
        seed_lesson_course(db, JAVA_PATH, stamp)
        # Retire the earlier Java modules before seeding, so the new assessments can take their positions.
        restructure_java_course(db, JAVA_PATH, stamp)
        seed_checkpoints(db, JAVA_PATH)
        # Assessments saved before the three-attempt rule keep their history but allow no more than three attempts.
        db['assessments'].update({'max_attempts': {'$gt': MAX_EXAM_ATTEMPTS}}, {'max_attempts': MAX_EXAM_ATTEMPTS})
        db.commit()
    finally:
        db.close()


def insert_missing(db, table, rows, scope):
    """INSERT OR IGNORE for many rows of a table whose only unique constraint is its primary key: one read of the
    existing keys within scope (a filter every row matches), then one insert of the rows not yet present."""
    key = store.TABLES[table]['pk']
    present = {tuple(r[c] for c in key) for r in db[table].find(scope, key)}
    missing = []
    for row in rows:
        identity = tuple(row[c] for c in key)
        if identity not in present:
            present.add(identity)
            missing.append(row)
    db[table].insert_many(missing)


def bulk_write(db, table, operations):
    """Apply pymongo write operations to a table in one round trip, inside the connection's transaction."""
    if operations:
        db.lock_for_write()
        db.collection(table).bulk_write(operations, ordered=True, session=db.active_session())


def bulk_update(db, table, changes):
    """UPDATE table SET fields WHERE filter for many (filter, fields) pairs in one round trip."""
    bulk_write(db, table, [UpdateOne(where, {'$set': store.coerce_fields(table, fields)}) for where, fields in changes])


def bulk_upsert(db, table, rows, updated):
    """INSERT ... ON CONFLICT(id) DO UPDATE SET <updated columns> for many rows in one round trip (single-column primary key)."""
    key = store.TABLES[table]['pk'][0]
    operations = []
    for fields in rows:
        full = store.with_defaults(table, fields)
        on_insert = {c: v for c, v in full.items() if c not in updated and c != key}
        on_insert['_id'] = full[key]
        operations.append(UpdateOne({key: full[key]}, {'$set': {c: full[c] for c in updated}, '$setOnInsert': on_insert}, upsert=True))
    bulk_write(db, table, operations)


def add_category(db, name, stamp):
    """INSERT OR IGNORE INTO course_categories (the name is case-insensitive)."""
    db['course_categories'].upsert({'name': name}, {}, insert_only={'created_at': stamp})


def seed_admin(target=None, source=ADMIN_SEED):
    """Create the packaged administrator when the database has none, so a fresh clone opens on the login page.

    The seed file holds a salted scrypt hash, never the password. An existing account with the same email is left unchanged.
    """
    if not source.exists():
        return
    admin = json.loads(source.read_text(encoding='utf-8'))
    db = connect(target)
    try:
        with db:
            if db['candidates'].exists({'role': 'admin'}) or db['candidates'].exists({'email': admin['email'].casefold()}):
                return
            stamp = datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
            db['candidates'].insert({'id': admin['id'], 'full_name': admin['name'], 'email': admin['email'].casefold(), 'password_hash': admin['passwordHash'],
                                     'created_at': stamp, 'updated_at': stamp, 'role': 'admin', 'must_change_password': 0})
            db['course_runs'].insert({'id': str(uuid.uuid4()), 'candidate_id': admin['id'], 'course_id': COURSE_ID, 'run_number': 1, 'started_at': stamp})
            db['admin_events'].insert({'admin_id': admin['id'], 'action': 'admin_setup', 'target_id': admin['id'],
                                       'detail': 'Packaged administrator created from admin-seed.json', 'created_at': stamp})
    finally:
        db.close()


def course_deleted(db, course_id):
    """A course removed in Manage Courses; packaged courses are then not re-created.

    initialize() reads the deleted courses once into db.deleted_courses (nothing during initialization changes them),
    saving a round trip per packaged course."""
    known = getattr(db, 'deleted_courses', None)
    if known is not None:
        return course_id in known
    return db['deleted_courses'].exists({'course_id': course_id})


def seed_assessment(db, identity, course_id, kind, title, description, settings, questions, stamp):
    """Create or refresh a packaged assessment. Banks that employees have already attempted are left unchanged."""
    seed_assessments(db, [(identity, course_id, kind, title, description, settings, questions)], stamp)


def seed_assessments(db, items, stamp):
    """seed_assessment for several assessments at once: items are (identity, course_id, kind, title, description, settings, questions)."""
    attempted = set(db['assessment_attempts'].distinct('assessment_id', {'assessment_id': {'$in': [item[0] for item in items]}}))
    pending = {}
    for item in items:
        if item[0] not in attempted:
            pending[item[0]] = item  # A repeated identity ends with its last definition, as repeated calls did.
    if not pending:
        return
    present = set(db['assessments'].distinct('id', {'id': {'$in': list(pending)}}))
    new, changes, bank = [], [], []
    for identity, course_id, kind, title, description, settings, questions in pending.values():
        values = {'title': title, 'description': description, 'kind': kind, 'course_id': course_id, 'pass_percent': settings['passPercent'],
                  'max_attempts': min(settings['maxAttempts'], MAX_EXAM_ATTEMPTS), 'question_count': settings.get('questionCount', len(questions)),
                  'time_limit_minutes': settings['timeLimitMinutes'], 'status': 'published', 'updated_at': stamp}
        if identity in present:
            changes.append(({'id': identity}, values))
        else:
            new.append({'id': identity, **values, 'created_at': stamp})
        for position, (prompt, options, correct, explanation) in enumerate(questions):
            bank.append({'id': f'{identity}-q{position + 1:02d}', 'assessment_id': identity, 'position': position, 'prompt': prompt,
                         'options_json': json.dumps(options), 'correct_option': correct, 'explanation': explanation, 'code': ''})
    bulk_update(db, 'assessments', changes)
    db['assessments'].insert_many(new)
    db['assessment_bank'].delete({'assessment_id': {'$in': list(pending)}})
    db['assessment_bank'].insert_many(bank)


def course_fingerprint(db, course_id):
    """SHA-256 of the editable course content: course title, category, description and each lesson's text fields."""
    course = db['courses'].find_one({'id': course_id}, ['title', 'category', 'description'])
    columns = ['title', 'description', 'content', 'document_url', 'resources_json', 'activity_json']
    lessons = db['course_lessons'].find({'course_id': course_id}, columns, sort='position')
    return hashlib.sha256(json.dumps([[course['title'], course['category'], course['description']], [[l[c] for c in columns] for l in lessons]], ensure_ascii=False).encode()).hexdigest()


def seed_lesson_course(db, source, stamp):
    """Add a packaged lesson-based course, or upgrade an older packaged version.

    A course that an administrator has edited in Manage Courses is never overwritten. A course that was saved
    without changes still matches the fingerprint of an earlier packaged version, so it is upgraded. Lesson ids
    are stable, so employee progress stays attached to the same lessons across upgrades.
    """
    if not source.exists():
        return
    course = json.loads(source.read_text(encoding='utf-8'))
    if course_deleted(db, course['id']):
        return
    if 'finalAssessment' not in course:
        return seed_native_lesson_course(db, source, stamp)
    existing = db['courses'].find_one({'id': course['id']}, ['version'])
    if existing and existing['version'] >= course['version']:
        return
    saved = existing and db['admin_events'].exists({'action': 'course_saved', 'target_id': course['id']})
    if saved and course_fingerprint(db, course['id']) not in course.get('unchangedFingerprints', []):
        return
    add_category(db, course['category'], stamp)
    fields = {'title': course['title'], 'category': course['category'], 'description': course['description'], 'status': course['status'],
              'difficulty': course['difficulty'], 'duration_minutes': course['durationMinutes'], 'visibility': course['visibility'],
              'version': course['version'], 'page_layout': course.get('pageLayout', 'standard'), 'format': 'lessons', 'updated_at': stamp}
    # The final assessment, when the course has one, is required for the certificate (set here with the course row,
    # saving a separate update; it is seeded below).
    final = course.get('finalAssessment')
    if final:
        fields['post_assessment_id'] = final['id']
    if existing:
        db['courses'].update({'id': course['id']}, fields)
    else:
        db['courses'].insert({'id': course['id'], **fields, 'sets_json': '[]', 'lessons_json': '[]'})
    assessments = []
    if final:
        assessments.append((final['id'], course['id'], 'post', final['title'], final['description'], final, final['questions']))
    kept, lessons = [], []
    for position, lesson in enumerate(course['lessons']):
        lesson_id = f"{course['id']}-{lesson['slug']}"
        kept.append(lesson_id)
        # A lesson can show the final assessment inline as its knowledge check (single-lesson courses such as RAG).
        check_id = final['id'] if final and lesson.get('usesFinalAssessment') else None
        if lesson.get('knowledgeCheck'):
            check_id = f"{course['id']}-check-{position + 1}"
            assessments.append((check_id, course['id'], 'knowledge', f"Knowledge check: {lesson['title']}", 'A short check of this lesson. Answers are explained after you submit.',
                                course['knowledgeCheck'], lesson['knowledgeCheck']))
        # Text-based lessons: no video, captions or video length.
        lessons.append({'id': lesson_id, 'course_id': course['id'], 'position': position, 'title': lesson['title'], 'description': lesson['description'],
                        'content': lesson['content'], 'duration_minutes': lesson['durationMinutes'],
                        'activity_json': json.dumps(lesson['activity']) if lesson.get('activity') else '', 'assessment_id': check_id,
                        'video_url': '', 'captions_url': '', 'video_seconds': 0, 'created_at': stamp, 'updated_at': stamp})
    seed_assessments(db, assessments, stamp)
    bulk_upsert(db, 'course_lessons', lessons, ['position', 'title', 'description', 'content', 'duration_minutes', 'activity_json', 'assessment_id',
                                                'video_url', 'captions_url', 'video_seconds', 'updated_at'])
    # Video watch records from an earlier packaged version no longer apply to these text lessons.
    db['lesson_watch'].delete({'lesson_id': {'$in': kept}})


def seed_native_lesson_course(db, source, stamp):
    """Add a packaged lesson-based course once. Later edits in Manage Courses are never overwritten."""
    if not source.exists():
        return
    course = json.loads(source.read_text(encoding='utf-8'))
    if course_deleted(db, course['id']):
        return
    manifest_path = VIDEO_ROOT / course['id'] / 'manifest.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8')) if manifest_path.exists() and course.get('videoEnabled', True) else {}
    if not db['courses'].exists({'id': course['id']}):
        add_category(db, course['category'], stamp)
        db['courses'].insert({'id': course['id'], 'title': course['title'], 'version': 1, 'category': course['category'], 'description': course['description'],
                              'status': course['status'], 'sets_json': '[]', 'lessons_json': '[]', 'updated_at': stamp, 'difficulty': course['difficulty'],
                              'duration_minutes': course['durationMinutes'], 'format': 'lessons', 'visibility': course['visibility']})
        rows = []
        for position, lesson in enumerate(course['lessons']):
            media = f"api/videos/{course['id']}/{lesson['slug']}"
            video = course.get('videoEnabled', True)
            rows.append({'id': f"{course['id']}-{lesson['slug']}", 'course_id': course['id'], 'position': position, 'title': lesson['title'],
                         'description': lesson['description'], 'video_url': media + '.mp4' if video else '', 'content': lesson['content'],
                         'duration_minutes': lesson['durationMinutes'], 'created_at': stamp, 'updated_at': stamp, 'captions_url': media + '.vtt' if video else '',
                         'video_seconds': manifest.get(lesson['slug'], {}).get('seconds', 0), 'completion_percent': lesson['completionPercent'],
                         'activity_json': json.dumps(lesson['activity']) if lesson.get('activity') else '',
                         'practice_json': json.dumps(lesson['practice']) if lesson.get('practice') else '',
                         'quiz_json': json.dumps(lesson['quiz']) if lesson.get('quiz') else ''})
        db['course_lessons'].insert_many(rows)
    # Videos rendered after the course was first seeded: record their length so the watch threshold applies.
    bulk_update(db, 'course_lessons', [({'id': f"{course['id']}-{slug}", 'video_seconds': 0}, {'video_seconds': info['seconds']}) for slug, info in manifest.items()])


def content_updated(db, course_id, revision):
    return db['course_content_updates'].exists({'course_id': course_id, 'revision': revision})


def upgrade_python_interactive(db, source, stamp):
    """One-time, authorized conversion of the packaged Python course; keep learner records intact."""
    if not source.exists():
        return
    course = json.loads(source.read_text(encoding='utf-8'))
    if course_deleted(db, course['id']):
        return
    revision = 'interactive-v1'
    if not course.get('interactive') or content_updated(db, course['id'], revision):
        return
    bulk_update(db, 'course_lessons', [({'id': f"{course['id']}-{lesson['slug']}", 'course_id': course['id']},
                                        {'content': lesson['content'], 'practice_json': json.dumps(lesson['practice']), 'quiz_json': json.dumps(lesson['quiz']),
                                         'video_url': '', 'captions_url': '', 'video_seconds': 0, 'updated_at': stamp}) for lesson in course['lessons']])
    db['courses'].update({'id': course['id']}, {'description': course['description'], 'updated_at': stamp})
    db['course_content_updates'].insert({'course_id': course['id'], 'revision': revision, 'applied_at': stamp})


def upgrade_python_lessons(db, source, stamp):
    """Expand the packaged Python summaries once without resetting learning or overwriting trainer edits."""
    if not source.exists():
        return
    course = json.loads(source.read_text(encoding='utf-8'))
    if course_deleted(db, course['id']):
        return
    revision = course.get('contentRevision')
    if not revision or content_updated(db, course['id'], revision):
        return
    identities = [f"{course['id']}-{lesson['slug']}" for lesson in course['lessons']]
    current = {r['id']: r['content'] for r in db['course_lessons'].find({'id': {'$in': identities}, 'course_id': course['id']}, ['id', 'content'])}
    changes = []
    for identity, lesson in zip(identities, course['lessons']):
        if identity in current and hashlib.sha256(current[identity].encode('utf-8')).hexdigest() == lesson.get('legacyContentHash'):
            changes.append(({'id': identity}, {'content': lesson['content'], 'updated_at': stamp}))
    bulk_update(db, 'course_lessons', changes)
    db['course_content_updates'].insert({'course_id': course['id'], 'revision': revision, 'applied_at': stamp})


def restructure_java_course(db, source, stamp):
    """Move an installed Java course to the packaged module structure once.

    Modules and assignments from an earlier structure move, with every learner record attached to them, to an
    archived copy of the course. Earned certificates are unaffected. Current runs continue on the new modules; an
    assignment attempt left open on a retired assignment is ended. Later initialization never repeats this, so
    subsequent trainer edits are kept.
    """
    if not source.exists():
        return
    course = json.loads(source.read_text(encoding='utf-8'))
    if course_deleted(db, course['id']):
        return
    revision = course.get('contentRevision')
    if not revision or content_updated(db, course['id'], revision):
        return
    lesson_ids = [f"{course['id']}-{lesson['slug']}" for lesson in course['lessons']]
    checkpoint_ids = [item['id'] for item in course['assignments']]
    stale_lessons = [r['id'] for r in db['course_lessons'].find({'course_id': course['id'], 'id': {'$nin': lesson_ids}}, ['id'])]
    stale_checkpoints = [r['id'] for r in db['course_checkpoints'].find({'course_id': course['id'], 'id': {'$nin': checkpoint_ids}}, ['id'])]
    if stale_lessons or stale_checkpoints:
        archive = f"{course['id']}-previous-edition"
        old = db['courses'].get(course['id'])
        db['courses'].insert_ignore({'id': archive, 'title': old['title'] + ' (previous edition)', 'version': 1, 'category': old['category'], 'description': old['description'],
                                     'status': 'archived', 'sets_json': '[]', 'lessons_json': '[]', 'updated_at': stamp, 'difficulty': old['difficulty'],
                                     'duration_minutes': old['duration_minutes'], 'format': 'lessons', 'visibility': old['visibility']})
        if stale_checkpoints:
            db['checkpoint_attempts'].update({'status': 'in-progress', 'checkpoint_id': {'$in': stale_checkpoints}},
                                             {'status': 'terminated', 'reason': 'This assignment was retired when the course was restructured.', 'finished_at': stamp})
            db['course_checkpoints'].update({'id': {'$in': stale_checkpoints}}, {'course_id': archive})
        if stale_lessons:
            db['course_lessons'].update({'id': {'$in': stale_lessons}}, {'course_id': archive})
            db['course_runs'].update({'course_id': course['id'], 'last_lesson_id': {'$in': stale_lessons}}, {'last_lesson_id': None})
        db['courses'].update({'id': course['id']}, {'description': course['description'], 'duration_minutes': course['durationMinutes'], 'updated_at': stamp})
    bulk_upsert(db, 'course_lessons', [{'id': lesson_ids[position], 'course_id': course['id'], 'position': position, 'title': lesson['title'],
                                        'description': lesson['description'], 'video_url': '', 'content': lesson['content'], 'duration_minutes': lesson['durationMinutes'],
                                        'created_at': stamp, 'updated_at': stamp, 'captions_url': '', 'video_seconds': 0,
                                        'completion_percent': lesson['completionPercent'], 'quiz_json': json.dumps(lesson['quiz'])}
                                       for position, lesson in enumerate(course['lessons'])],
                ['position', 'title', 'description', 'content', 'duration_minutes', 'completion_percent', 'quiz_json', 'updated_at'])
    db['course_content_updates'].insert({'course_id': course['id'], 'revision': revision, 'applied_at': stamp})


def seed_checkpoints(db, source):
    """Add newly packaged assignments to existing courses without changing learner records."""
    if not source.exists():
        return
    course = json.loads(source.read_text(encoding='utf-8'))
    if course_deleted(db, course['id']):
        return
    items = course.get('assignments', [])
    if not items:
        return
    # INSERT OR IGNORE: skip an assignment whose id, or whose place after a lesson in this course, is already taken.
    existing = db['course_checkpoints'].find({'$or': [{'id': {'$in': [item['id'] for item in items]}},
                                                      {'course_id': course['id'], 'after_lesson': {'$in': [item['afterLesson'] for item in items]}}]},
                                             ['id', 'course_id', 'after_lesson'])
    taken_ids = {r['id'] for r in existing}
    taken_slots = {r['after_lesson'] for r in existing if r['course_id'] == course['id'] and r['after_lesson'] is not None}
    rows = []
    for item in items:
        if item['id'] in taken_ids or item['afterLesson'] in taken_slots:
            continue
        taken_ids.add(item['id'])
        if item['afterLesson'] is not None:
            taken_slots.add(item['afterLesson'])
        rows.append({'id': item['id'], 'course_id': course['id'], 'after_lesson': item['afterLesson'], 'title': item['title'], 'instructions': item['instructions'],
                     'lesson_ids_json': json.dumps(item['lessonIds']), 'questions_json': json.dumps(item['questions']),
                     'pass_percent': item.get('passPercent', 75), 'max_attempts': item.get('maxAttempts', 3), 'time_limit_seconds': item.get('timeLimitSeconds', 600)})
    db['course_checkpoints'].insert_many(rows)


def public_curriculum(db, course_id=COURSE_ID):
    row = db['courses'].find_one({'id': course_id}, ['sets_json'])
    result = json.loads(row['sets_json'])
    targets = {}
    for s, item in enumerate(result):
        for kind, e, target in [('exam', -1, item['exam'])] + [('exercise', i, ex['questions']) for i, ex in enumerate(item['exercises'])]:
            target.clear()
            targets[(s,kind,e)]=target
    for question in db['assessment_questions'].find({'course_id': course_id}, ['set_index', 'kind', 'exercise_index', 'prompt', 'options_json'],
                                                    sort=['set_index', 'kind', 'exercise_index', 'question_index']):
        target=targets.get((question['set_index'],question['kind'],question['exercise_index']))
        if target is not None:
            target.append([question['prompt'],json.loads(question['options_json'])])
    return result
