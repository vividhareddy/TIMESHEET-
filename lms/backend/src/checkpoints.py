"""Required, timed assignment checkpoints. All authorization and grading run on the server."""
import json
import secrets
import time

from services import check, now, scalar, uid


def expire(db, run_id, reason=None):
    attempts = {'run_id': run_id, 'status': 'in-progress'}
    if not reason:
        attempts['deadline'] = {'$lte': time.time()}
        # Checked with a read first: usually nothing has expired, and a read does not take the writer lock.
        if not db['checkpoint_attempts'].exists(attempts):
            return
    db['checkpoint_attempts'].update(attempts, {'status': 'terminated', 'reason': reason or 'Time expired. This assignment attempt has ended.', 'finished_at': now()})


def has_passed(db, run_id, checkpoint_id):
    return db['checkpoint_attempts'].exists({'run_id': run_id, 'checkpoint_id': checkpoint_id, 'status': 'passed'})


def _passed_ids(db, run_id):
    """Ids of the assignments this run has passed."""
    return set(db['checkpoint_attempts'].distinct('checkpoint_id', {'run_id': run_id, 'status': 'passed'})) if run_id is not None else set()


def all_passed(db, run_id):
    run = db['course_runs'].get(run_id, ['course_id'])
    if run is None:
        return True
    passed = _passed_ids(db, run_id)
    return all(identity in passed for identity in db['course_checkpoints'].distinct('id', {'course_id': run['course_id']}))


def _open_checkpoint(db, run_id, course_id, after_lesson):
    """Whether an assignment of the course matching the after_lesson condition is not yet passed by the run."""
    passed = _passed_ids(db, run_id)
    return any(c['id'] not in passed for c in db['course_checkpoints'].find({'course_id': course_id, 'after_lesson': after_lesson}, ['id']))


def lesson_unlocked(db, run_id, course_id, lesson_id):
    row = db['course_lessons'].find_one({'id': lesson_id, 'course_id': course_id}, ['position'])
    if row is None:
        return False
    return not _open_checkpoint(db, run_id, course_id, {'$lte': row['position']})


def unlock_threshold(db, run_id, course_id):
    """Position of the earliest assignment this run has not passed (None when every one is passed).
    A lesson is unlocked exactly when no such assignment sits at or before it, so one query answers it for every lesson."""
    passed = _passed_ids(db, run_id)
    positions = [c['after_lesson'] for c in db['course_checkpoints'].find({'course_id': course_id}, ['id', 'after_lesson']) if c['id'] not in passed and c['after_lesson'] is not None]
    return min(positions) if positions else None


def ready(db, run_id, checkpoint):
    lesson_ids = json.loads(checkpoint['lesson_ids_json'])
    completed = set(db['lesson_progress'].distinct('lesson_id', {'run_id': run_id}))
    previous = _open_checkpoint(db, run_id, checkpoint['course_id'], {'$lt': checkpoint['after_lesson']})
    return not previous and bool(lesson_ids) and all(identity in completed for identity in lesson_ids)


def attempt_view(row):
    return {**{key: row[column] for key, column in (
        ('id', 'id'), ('status', 'status'), ('startedAt', 'started_at'), ('finishedAt', 'finished_at'),
        ('score', 'score'), ('total', 'total'), ('reason', 'reason'), ('attemptNumber', 'attempt_number'))},
        'deadline': row['deadline'] * 1000,
        'percent': round(row['score'] / row['total'] * 100) if row['score'] is not None else None}


def views(db, run_id, course_id):
    """Every assignment of the course with this run's attempts. Attempts and completed lessons are read once, and readiness
    follows the same rule as ready(): earlier assignments passed and this assignment's lessons completed."""
    checkpoints = db['course_checkpoints'].find({'course_id': course_id}, sort='after_lesson')
    attempts, completed = [], set()
    if run_id and checkpoints:
        attempts = db['checkpoint_attempts'].find({'run_id': run_id}, sort=['checkpoint_id', 'attempt_number'])
        completed = set(db['lesson_progress'].distinct('lesson_id', {'run_id': run_id}))
    return build_views(checkpoints, attempts, completed, run_id)


def build_views(checkpoints, attempt_rows, completed, run_id):
    """views() from rows already read: the course's checkpoints by after_lesson, the run's attempts by
    checkpoint_id,attempt_number, and the run's completed lesson ids."""
    by_checkpoint = {}
    if run_id and checkpoints:
        for a in attempt_rows:
            by_checkpoint.setdefault(a['checkpoint_id'], []).append(attempt_view(a))
    else:
        completed = set()
    passed = {c['id'] for c in checkpoints if any(a['status'] == 'passed' for a in by_checkpoint.get(c['id'], ()))}
    # One pass in position order: an assignment at an earlier position (ties excluded) that is not passed blocks this one.
    result, earlier_open, open_here, position = [], False, False, None
    for c in checkpoints:
        if c['after_lesson'] != position:
            earlier_open, open_here, position = earlier_open or open_here, False, c['after_lesson']
        open_here = open_here or c['id'] not in passed
        attempts = by_checkpoint.get(c['id'], [])
        lesson_ids = json.loads(c['lesson_ids_json'])
        is_ready = bool(run_id) and not earlier_open and bool(lesson_ids) and all(identity in completed for identity in lesson_ids)
        result.append({'id': c['id'], 'title': c['title'], 'instructions': c['instructions'], 'afterLesson': c['after_lesson'],
                       'firstLesson': c['after_lesson'] - max(len(lesson_ids), 1) + 1,
                       'passPercent': c['pass_percent'], 'maxAttempts': c['max_attempts'], 'timeLimitSeconds': c['time_limit_seconds'],
                       'questionCount': len(json.loads(c['questions_json'])), 'passed': any(a['status'] == 'passed' for a in attempts),
                       'ready': is_ready, 'attempts': attempts})
    return result


def start(db, run, data):
    c = db['course_checkpoints'].find_one({'id': scalar(data.get('checkpointId')), 'course_id': run['course_id']})
    check(c is not None, 'Assignment was not found.', 404)
    check(ready(db, run['id'], c), 'Complete the related modules and pass earlier assignments first.', 403)
    check(not has_passed(db, run['id'], c['id']), 'This assignment is already passed.', 409)
    check(not db['checkpoint_attempts'].exists({'run_id': run['id'], 'status': 'in-progress'}),
          'An assignment is already active. Reopen the course to end the interrupted attempt.', 409)
    number = db['checkpoint_attempts'].count({'run_id': run['id'], 'checkpoint_id': c['id']}) + 1
    check(number <= c['max_attempts'], 'All assignment attempts have been used. Start a new course run to try again.', 409)
    # Store the shuffled questions and keys as an immutable server-side snapshot for this attempt.
    questions = json.loads(c['questions_json'])
    rng = secrets.SystemRandom()
    rng.shuffle(questions)
    for q in questions:
        order = list(range(len(q['options'])))
        rng.shuffle(order)
        q['correct'] = order.index(q['correct'])
        q['options'] = [q['options'][i] for i in order]
    identity = uid()
    row = db['checkpoint_attempts'].insert({'id': identity, 'run_id': run['id'], 'checkpoint_id': c['id'], 'attempt_number': number, 'status': 'in-progress',
                                            'started_at': now(), 'deadline': time.time() + c['time_limit_seconds'], 'total': len(questions), 'questions_json': json.dumps(questions)})
    attempt = attempt_view(row)
    public = [{k: q[k] for k in ('prompt', 'code', 'options') if k in q} for q in questions]
    return {'attempt': attempt, 'questions': public}


def finish(db, run, data):
    a = db['checkpoint_attempts'].find_one({'id': scalar(data.get('attemptId')), 'run_id': run['id']})
    check(a is not None, 'Assignment attempt was not found.', 404)
    if a['status'] == 'in-progress':
        if data.get('terminate') is True:
            reason = str(data.get('reason') or 'The assignment attempt was ended.')[:300]
            db['checkpoint_attempts'].update({'id': a['id']}, {'status': 'terminated', 'reason': reason, 'finished_at': now()})
        else:
            questions, answers = json.loads(a['questions_json']), data.get('answers')
            check(isinstance(answers, list) and len(answers) == len(questions), 'Answer every assignment question.')
            check(all(type(answer) is int and 0 <= answer < len(q['options']) for answer, q in zip(answers, questions)), 'Invalid assignment answer.')
            score = sum(answer == q['correct'] for answer, q in zip(answers, questions))
            threshold = db['course_checkpoints'].get(a['checkpoint_id'], ['pass_percent'])['pass_percent']
            status = 'passed' if score * 100 >= threshold * a['total'] else 'failed'
            db['checkpoint_attempts'].update({'id': a['id']}, {'status': status, 'score': score, 'answers_json': json.dumps(answers), 'finished_at': now()})
    # Finished submissions are idempotent: replaying cannot change a mark or revive a terminated attempt.
    return {'attempt': attempt_view(db['checkpoint_attempts'].get(a['id']))}
