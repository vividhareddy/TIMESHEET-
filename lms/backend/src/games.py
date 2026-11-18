"""Revision games: replay the questions of knowledge checks and assessments the employee has already passed.

Every course gets games from whatever questions it has: inline lesson quizzes, assessments linked to lessons, and
the course's final assessment. Each source is released only after the employee passes it, or once the whole course is completed (a passed assessment
cannot be retaken, and its results already show the answers), and nothing is released while an assessment or
assignment is running, so the games never weaken a graded check.
"""
import json
import time

from services import check, current_run, scalar

MIN_OPTIONS = 2


def _question(prompt, options, correct, explanation=''):
    """A playable question, or None when the stored item cannot be used in a game."""
    if not (isinstance(prompt, str) and prompt.strip() and isinstance(options, list) and len(options) >= MIN_OPTIONS):
        return None
    if not (type(correct) is int and 0 <= correct < len(options) and all(isinstance(o, str) and o.strip() for o in options)):
        return None
    return {'prompt': prompt.strip(), 'options': options, 'answer': correct, 'explanation': explanation if isinstance(explanation, str) else ''}


def _quiz_questions(raw):
    items = []
    for q in json.loads(raw):
        # Inline quiz items are [prompt, options, correct, explanation?, code?]; code questions do not fit the game cards.
        if not isinstance(q, list) or len(q) < 3 or (len(q) > 4 and q[4]):
            continue
        items.append(_question(q[0], q[1], q[2], q[3] if len(q) > 3 else ''))
    return [q for q in items if q]


def _bank_questions(db, assessment_ids):
    """assessment id -> playable questions in bank order, for many assessments in one query."""
    ids = sorted(set(assessment_ids))
    banks = {}
    if ids:
        for r in db['assessment_bank'].find({'assessment_id': {'$in': ids}}, sort=['assessment_id', 'position']):
            question = None if r['code'] else _question(r['prompt'], json.loads(r['options_json']), r['correct_option'], r['explanation'] or '')
            if question:
                banks.setdefault(r['assessment_id'], []).append(question)
    return banks


def lesson_games(db, user, query):
    course_id = (query.get('courseId') or [''])[0]
    course = db['courses'].find_one({'id': scalar(course_id), 'status': 'published'}, ['id', 'post_assessment_id'])
    check(course is not None, 'This course is unavailable.', 404)
    run = current_run(db, user['id'], course_id=course_id)
    # Attempts left open past their deadline are abandoned, not active, so they do not block play.
    moment = time.time()
    busy = db['assessment_attempts'].exists({'employee_id': user['id'], 'status': 'in-progress', 'deadline': {'$gt': moment}}) or \
        db['checkpoint_attempts'].exists({'run_id': run['id'], 'status': 'in-progress', 'deadline': {'$gt': moment}})
    check(not busy, 'Finish your active assessment before playing revision games.', 409)
    passed_lessons = set(db['lesson_progress'].distinct('lesson_id', {'run_id': run['id']}))
    passed_checks = set(db['assessment_attempts'].distinct('assessment_id', {'employee_id': user['id'], 'status': 'passed'}))
    # A completed course opens every game, even for optional lesson checks that were skipped along the way.
    completed = run['completed_at'] is not None
    lessons, released = [], set()

    def add(identity, title, questions):
        # The same question can sit in a lesson check and the final assessment; play it once.
        fresh = []
        for q in questions:
            key = (q['prompt'].lower(), q['options'][q['answer']].strip().lower())
            if key not in released:
                released.add(key)
                fresh.append(q)
        if fresh:
            lessons.append({'id': identity, 'title': title, 'questions': fresh})

    rows = db['course_lessons'].find({'course_id': course_id}, ['id', 'title', 'quiz_json', 'assessment_id'], sort='position')
    linked = {row['assessment_id'] for row in rows if not row['quiz_json'] and row['assessment_id']}
    final = course['post_assessment_id']
    final_open = bool(final) and final not in linked and (completed or final in passed_checks)
    # Every question bank that will be played is read in one query.
    banks = _bank_questions(db, [a for a in linked if completed or a in passed_checks] + ([final] if final_open else []))
    for row in rows:
        if row['quiz_json']:
            if completed or row['id'] in passed_lessons:
                add(row['id'], row['title'], _quiz_questions(row['quiz_json']))
        elif row['assessment_id'] and (completed or row['assessment_id'] in passed_checks):
            add(row['id'], row['title'], banks.get(row['assessment_id'], []))
    if final_open:
        add('final', 'Final assessment', banks.get(final, []))
    return {'courseId': course_id, 'lessons': lessons}
