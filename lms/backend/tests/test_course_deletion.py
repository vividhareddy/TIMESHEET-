"""Removing courses in Manage Courses: permanent deletion of unused courses, archiving when learners have records."""
from contextlib import closing
import tempfile
from pathlib import Path

import test_course_builder as builder
from test_portal import PortalFixture
from database import connect, initialize
from admin import delete_course


class CourseDeletionTests(PortalFixture):
    # Course-builder helpers, without running that class's tests again here.
    account, upload, course = builder.CourseBuilderTests.account, builder.CourseBuilderTests.upload, builder.CourseBuilderTests.course

    def read(self, work):
        with closing(connect(self.db_path)) as db:
            return work(db)

    def test_unused_course_and_its_content_are_deleted(self):
        identity, _ = self.course(status='published')
        employee = self.account('Assigned Employee')
        self.assertEqual(self.admin.request('manage/assignments', {'courseId': identity, 'targetType': 'employee', 'targetId': employee.id})[0], 200)
        assessment = self.read(lambda db: db['courses'].get(identity)['post_assessment_id'])
        self.assertIsNotNone(assessment)
        result = self.admin.request(f'admin/courses/{identity}/delete', {})
        self.assertEqual(result[0], 200, result[1])
        self.assertNotIn(identity, [c['id'] for c in self.admin.request('admin/courses')[1]['courses']])
        self.assertNotIn(identity, [c['id'] for c in employee.request('courses')[1]['courses']])
        for table in ('courses', 'course_lessons', 'course_assignments'):
            column = 'id' if table == 'courses' else 'course_id'
            self.assertEqual(self.read(lambda db: db[table].count({column: identity})), 0, table)
        self.assertEqual(self.read(lambda db: db['assessments'].count({'id': assessment})), 0)
        self.assertEqual(self.read(lambda db: db['assessment_bank'].count({'assessment_id': assessment})), 0)
        self.assertEqual(self.read(lambda db: db['admin_events'].find({'target_id': identity}, ['action'], sort='-id')[0]['action']), 'course_deleted')
        self.assertEqual(self.admin.request(f'admin/courses/{identity}/delete', {})[0], 404)

    def test_course_with_learner_records_is_archived_not_deleted(self):
        identity, _ = self.course(status='published')
        employee = self.account('Enrolled Employee')
        self.assertEqual(employee.request('learning/enroll', {'courseId': identity})[0], 200)
        listed = next(c for c in self.admin.request('admin/courses')[1]['courses'] if c['id'] == identity)
        self.assertEqual(listed['learners'], 1)
        refused = self.admin.request(f'admin/courses/{identity}/delete', {})
        self.assertEqual(refused[0], 409)
        self.assertIn('Archive it instead', refused[1]['error'])
        self.assertEqual(self.admin.request(f'admin/courses/{identity}/archive', {})[0], 200)
        self.assertEqual(self.read(lambda db: db['courses'].get(identity)['status']), 'archived')
        self.assertEqual(self.read(lambda db: db['course_runs'].count({'course_id': identity})), 1)
        self.assertNotIn(identity, [c['id'] for c in employee.request('courses')[1]['courses'] if c.get('status') == 'published'])

    def test_starter_course_and_other_trainers_courses_are_protected(self):
        self.assertEqual(self.admin.request('admin/courses/python-programming/delete', {})[0], 409)
        identity, _ = self.course()
        trainer = self.account('Course Trainer')
        with closing(connect(self.db_path)) as db, db:
            db['candidates'].update({'id': trainer.id}, {'role': 'trainer'})
        self.assertEqual(trainer.request(f'admin/courses/{identity}/delete', {})[0], 403)
        self.assertEqual(self.read(lambda db: db['courses'].count({'id': identity})), 1)

    def test_deleted_packaged_course_is_not_recreated_on_startup(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'deleted.sqlite3'
            initialize(path)
            with closing(connect(path)) as db, db:
                admin = {'id': 'admin-1', 'role': 'admin'}
                db['candidates'].insert({'id': 'admin-1', 'full_name': 'Admin', 'email': 'a@x.com', 'password_hash': 'x', 'role': 'admin', 'created_at': '2026-01-01', 'updated_at': '2026-01-01'})
                for course in ('java-full-stack-development', 'generative-ai-fundamentals'):
                    delete_course(db, admin, course)
            initialize(path)
            with closing(connect(path)) as db:
                for course in ('java-full-stack-development', 'generative-ai-fundamentals'):
                    self.assertIsNone(db['courses'].get(course))
                    self.assertEqual(db['course_lessons'].count({'course_id': course}), 0)
                    self.assertEqual(db['course_checkpoints'].count({'course_id': course}), 0)
                self.assertIsNotNone(db['courses'].get('shimento-python-developer'))

