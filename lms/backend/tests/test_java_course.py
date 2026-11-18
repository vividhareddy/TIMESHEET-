"""Native Java course: 40 roadmap modules, an assessment after every module, private grading and completion."""
import json
import tempfile
from contextlib import closing
from pathlib import Path

import test_genai_course as genai
from test_portal import PortalFixture
from test_portal import copy_database
from database import JAVA_PATH, connect, initialize

COURSE = 'java-full-stack-development'
DATA = json.loads(JAVA_PATH.read_text(encoding='utf-8'))
MODULES = len(DATA['lessons'])



class JavaCourseTests(PortalFixture):
    employee = genai.GenerativeAICourseTests.employee

    def enrolled(self):
        learner = self.employee('Java Learner')
        self.assertEqual(learner.request('learning/enroll', {'courseId': COURSE})[0], 200)
        return learner, learner.request('learning?courseId=' + COURSE)[1]

    def complete(self, learner, index):
        lesson = DATA['lessons'][index]
        result = learner.action('lesson-quiz', lessonId=f'{COURSE}-{lesson["slug"]}', answers=[q[2] for q in lesson['quiz']])
        self.assertEqual(result[0], 200, result[1])
        self.assertTrue(result[1]['quizResult']['passed'])
        return result[1]

    def answers(self, attempt):
        with closing(connect(self.db_path)) as db:
            questions = json.loads(db['checkpoint_attempts'].get(attempt['id'])['questions_json'])
        return [q['correct'] for q in questions]

    def test_roadmap_structure_and_an_assessment_after_every_module(self):
        learner, data = self.enrolled()
        course = next(c for c in learner.request('courses')[1]['courses'] if c['id'] == COURSE)
        self.assertEqual((course['title'], course['lessonCount'], course['durationMinutes']), (DATA['title'], 40, DATA['durationMinutes']))
        self.assertEqual([l['title'] for l in data['courseLessons']], [l['title'] for l in DATA['lessons']])
        self.assertEqual(DATA['phases'], ['Programming Fundamentals', 'Database Fundamentals', 'Frontend Development', 'Build Tools',
                                          'Version Control', 'Backend Development', 'Real-World Projects'])
        checkpoints = data['learning']['run']['checkpoints']
        self.assertEqual([c['afterLesson'] for c in checkpoints], list(range(1, 41)))
        self.assertEqual([c['firstLesson'] for c in checkpoints], list(range(1, 41)))
        self.assertTrue(all((c['passPercent'], c['maxAttempts'], c['timeLimitSeconds'], c['questionCount']) == (75, 3, 600, 8) for c in checkpoints[:-1]))
        self.assertEqual((checkpoints[-1]['title'], checkpoints[-1]['timeLimitSeconds'], checkpoints[-1]['questionCount']), ('Final Course Assessment', 1800, 20))
        first = data['courseLessons'][0]
        self.assertEqual((first['videoUrl'], first['practice'], len(first['quiz'])), ('', None, 3))
        for heading in ('## Learning objectives', '### JDK vs JRE vs JVM', '## Practice exercise', '## Key takeaways'):
            self.assertIn(heading, first['content'])
        self.assertNotIn('"correct"', json.dumps(data))
        # The next module stays locked until this module's assessment is passed.
        self.assertTrue(data['courseLessons'][1]['locked'])
        self.assertEqual((data['courseLessons'][1]['content'], data['courseLessons'][1]['quiz']), ('', []))
        self.assertEqual(learner.action('lesson', lessonId=first['id'])[0], 409)
        self.assertEqual(learner.action('lesson-quiz', lessonId=first['id'], answers=[True] * 3)[0], 400)
        self.assertEqual(learner.action('checkpoint-start', checkpointId=checkpoints[0]['id'])[0], 403)
        self.assertEqual(learner.action('lesson-quiz', lessonId=data['courseLessons'][1]['id'], answers=[0] * 3)[0], 403)

    def test_assessment_questions_carry_code_without_answer_keys(self):
        learner, data = self.enrolled()
        self.complete(learner, 0)
        started = learner.action('checkpoint-start', checkpointId=data['learning']['run']['checkpoints'][0]['id'])
        self.assertEqual(started[0], 200, started[1])
        self.assertEqual(len(started[1]['questions']), 8)
        self.assertNotIn('"correct"', json.dumps(started[1]))
        self.assertTrue(any('System.out.println' in q.get('code', '') for q in started[1]['questions']))

    def test_security_ownership_deadline_reload_and_attempt_limits(self):
        learner, data = self.enrolled()
        other, _ = self.enrolled()
        self.complete(learner, 0)
        checkpoint = data['learning']['run']['checkpoints'][0]
        attempt = learner.action('checkpoint-start', checkpointId=checkpoint['id'])[1]['attempt']
        self.assertEqual(other.action('checkpoint-finish', attemptId=attempt['id'], terminate=True)[0], 404)
        self.assertEqual(other.request('learning/checkpoint-finish', {'runId': learner.run, 'attemptId': attempt['id'], 'terminate': True})[0], 409)
        self.assertEqual(learner.request('learning/checkpoint-finish', {'runId': learner.run, 'attemptId': attempt['id'], 'terminate': True}, {'X-CSRF-Token': 'wrong'})[0], 403)
        wrong = [(a + 1) % 4 for a in self.answers(attempt)]
        failed = learner.action('checkpoint-finish', attemptId=attempt['id'], answers=wrong, score=100, passed=True)[1]
        self.assertEqual((failed['attempt']['score'], failed['attempt']['status']), (0, 'failed'))
        second = learner.action('checkpoint-start', checkpointId=checkpoint['id'])[1]['attempt']
        resumed = learner.action('resume')[1]['learning']['run']['checkpoints'][0]
        self.assertEqual(resumed['attempts'][1]['status'], 'terminated')
        third = learner.action('checkpoint-start', checkpointId=checkpoint['id'])[1]['attempt']
        with closing(connect(self.db_path)) as db, db:
            db['checkpoint_attempts'].update({'id': third['id']}, {'deadline': 0})
        expired = learner.action('checkpoint-finish', attemptId=third['id'], answers=self.answers(third))[1]
        self.assertEqual(expired['attempt']['status'], 'terminated')
        self.assertIn('Time expired', expired['attempt']['reason'])
        self.assertEqual(learner.action('checkpoint-start', checkpointId=checkpoint['id'])[0], 409)
        replay = learner.action('checkpoint-finish', attemptId=second['id'], answers=self.answers(second))[1]
        self.assertEqual(replay['attempt']['status'], 'terminated')
        reset = learner.action('restart')[1]['learning']['run']
        self.assertEqual(reset['checkpoints'][0]['attempts'], [])
        self.assertFalse(reset['checkpoints'][0]['ready'])

    def test_all_modules_and_assessments_gate_the_certificate(self):
        learner, data = self.enrolled()
        for index, checkpoint in enumerate(data['learning']['run']['checkpoints']):
            state = self.complete(learner, index)
            self.assertIsNone(state['learning']['run']['completedAt'])
            self.assertEqual(state['learning']['certificates'], [])
            started = learner.action('checkpoint-start', checkpointId=checkpoint['id'])
            self.assertEqual(started[0], 200, started[1])
            attempt = started[1]['attempt']
            result = learner.action('checkpoint-finish', attemptId=attempt['id'], answers=self.answers(attempt))
            self.assertEqual(result[0], 200, result[1])
            self.assertEqual(result[1]['attempt']['status'], 'passed')
            if index == 0:
                fresh = learner.request('learning?courseId=' + COURSE)[1]
                self.assertFalse(fresh['courseLessons'][1]['locked'])
        self.assertEqual(len(result[1]['learning']['certificates']), 1)
        self.assertEqual(result[1]['learning']['certificates'][0]['courseTitle'], DATA['title'])
        self.assertIsNotNone(result[1]['learning']['run']['completedAt'])
        course = next(c for c in learner.request('courses')[1]['courses'] if c['id'] == COURSE)
        self.assertEqual(course['progress'], 100)

    def test_seed_reinitialization_keeps_existing_edits_and_has_no_duplicates(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'java.sqlite3'
            initialize(path)
            with closing(connect(path)) as db, db:
                db['courses'].update({'id': COURSE}, {'title': 'Custom Java course'})
                db['course_lessons'].update({'id': COURSE + '-module-01'}, {'content': 'Trainer edit'})
            initialize(path)
            with closing(connect(path)) as db:
                self.assertEqual(db['courses'].get(COURSE)['title'], 'Custom Java course')
                self.assertEqual(db['course_lessons'].get(COURSE + '-module-01')['content'], 'Trainer edit')
                self.assertEqual(db['course_lessons'].count({'course_id': COURSE}), 40)
                self.assertEqual(db['course_checkpoints'].count({'course_id': COURSE}), 40)
                self.assertIsNone(db['courses'].get(COURSE + '-previous-edition'))

    def test_restructure_archives_previous_edition_with_learner_history(self):
        learner, _ = self.enrolled()
        legacy = [f'{COURSE}-lesson-{n:02d}' for n in (1, 2, 3)]
        old_checkpoint = f'{COURSE}-assignment-01'
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'upgrade.sqlite3'
            copy_database(self.db_path, path)
            # Recreate an installation of the earlier edition: three modules, an assignment after module 3 and learner records.
            with closing(connect(path)) as db, db:
                db['course_content_updates'].delete({'course_id': COURSE, 'revision': DATA['contentRevision']})
                checkpoints = db['course_checkpoints'].distinct('id', {'course_id': COURSE})
                db['checkpoint_attempts'].delete({'checkpoint_id': {'$in': checkpoints}})
                lessons = db['course_lessons'].distinct('id', {'course_id': COURSE})
                for table in ('lesson_progress', 'lesson_quiz_attempts', 'lesson_code_drafts', 'lesson_watch'):
                    db[table].delete({'lesson_id': {'$in': lessons}})
                db['course_checkpoints'].delete({'course_id': COURSE})
                db['course_lessons'].delete({'course_id': COURSE})
                for position, identity in enumerate(legacy):
                    db['course_lessons'].insert({'id': identity, 'course_id': COURSE, 'position': position, 'title': f'Earlier module {position + 1}', 'description': '',
                                                 'content': 'Earlier edition', 'duration_minutes': 90, 'created_at': '2025-01-01', 'updated_at': '2025-01-01', 'quiz_json': '[]'})
                db['course_checkpoints'].insert({'id': old_checkpoint, 'course_id': COURSE, 'after_lesson': 3, 'title': 'Assignment 1', 'instructions': '',
                                                 'lesson_ids_json': json.dumps(legacy), 'questions_json': '[]'})
                db['lesson_progress'].insert({'run_id': learner.run, 'lesson_id': legacy[0], 'completed_at': '2025-01-02', 'score': 100})
                db['checkpoint_attempts'].insert({'id': 'legacy-attempt', 'run_id': learner.run, 'checkpoint_id': old_checkpoint, 'attempt_number': 1, 'status': 'in-progress',
                                                  'started_at': '2025-01-02', 'deadline': 9999999999, 'total': 8, 'questions_json': '[]'})
                db['certificates'].insert({'id': 'legacy-certificate', 'run_id': learner.run, 'candidate_name': 'Java Learner', 'course_title': DATA['title'], 'issued_at': '2025-01-03'})
                db['course_runs'].update({'id': learner.run}, {'last_lesson_id': legacy[1]})
            initialize(path)
            initialize(path)
            archive = COURSE + '-previous-edition'
            with closing(connect(path)) as db:
                self.assertEqual(db['courses'].get(archive)['status'], 'archived')
                self.assertEqual([r['id'] for r in db['course_lessons'].find({'course_id': archive}, ['id'], sort='position')], legacy)
                self.assertEqual([r['id'] for r in db['course_lessons'].find({'course_id': COURSE}, ['id'], sort='position')],
                                 [f'{COURSE}-{l["slug"]}' for l in DATA['lessons']])
                self.assertEqual([r['after_lesson'] for r in db['course_checkpoints'].find({'course_id': COURSE}, ['after_lesson'], sort='after_lesson')], list(range(1, 41)))
                self.assertEqual(db['course_checkpoints'].get(old_checkpoint)['course_id'], archive)
                attempt = db['checkpoint_attempts'].get('legacy-attempt')
                status, reason = attempt['status'], attempt['reason']
                self.assertEqual(status, 'terminated')
                self.assertIn('restructured', reason)
                self.assertIsNotNone(db['lesson_progress'].find_one({'run_id': learner.run, 'lesson_id': legacy[0]}))
                self.assertIsNotNone(db['certificates'].get('legacy-certificate'))
                self.assertIsNone(db['course_runs'].get(learner.run)['last_lesson_id'])
