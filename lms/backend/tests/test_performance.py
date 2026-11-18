"""Guard output compatibility, role scope, and bounded query counts."""
import copy
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tools'))
from benchmark_performance import COUNTER,fixture
from admin import admin_action,course_view,owns_course
from analytics import recommendations,activity_times
from database import CURRICULUM,public_curriculum


class PerformanceTests(unittest.TestCase):
    def setUp(self):self.db=fixture(12)
    def tearDown(self):
        self.db.close();self.db.client.drop_database(self.db.name)  # Free the throwaway database (the cluster limits collections).

    def measured(self,callback):
        # Counts MongoDB read commands (the former SQLite trace callback counted SELECT statements).
        COUNTER.count=0;COUNTER.active=True
        try:result=callback()
        finally:COUNTER.active=False
        return result,COUNTER.count

    def test_course_lists_preserve_metadata_order_and_role_scope(self):
        db=self.db;stamp='2026-01-01T00:00:00Z'
        db['candidates'].insert({'id':'trainer','full_name':'Trainer','email':'trainer@example.com','password_hash':'unused','created_at':stamp,'updated_at':stamp,'role':'trainer'})
        db['departments'].insert({'id':'department','name':'Engineering','created_at':stamp})
        db['courses'].update({'id':{'$in':['course-0002','course-0004']}},{'trainer_id':'trainer','department_id':'department'})
        for identity in ('resource-z','resource-a'):
            db['course_resources'].insert({'id':identity,'course_id':'course-0002','title':identity,'kind':'link','url':'https://example.com','created_at':stamp})
        db['course_assignments'].insert({'id':'assignment','course_id':'course-0002','target_type':'employee','target_id':'employee','assigned_at':stamp})
        for role in ('admin','hr','trainer'):
            actor=dict(db['candidates'].get('trainer' if role=='trainer' else 'admin'));actor['role']=role
            expected=[course_view(row,True,db) for row in db['courses'].find(sort='title') if owns_course(actor,row)]
            actual,count=self.measured(lambda:admin_action(db,actor,'GET','courses',{})['courses'])
            self.assertEqual(actual,expected)
            self.assertEqual(count,3)
            if role=='trainer':self.assertEqual([c['id'] for c in actual],['course-0002','course-0004'])

    def test_curriculum_reads_database_questions_without_answer_keys(self):
        expected=copy.deepcopy(CURRICULUM)
        for item in expected:
            item['exam']=[q[:2] for q in item['exam']]
            for ex in item['exercises']:ex['questions']=[q[:2] for q in ex['questions']]
        actual,count=self.measured(lambda:public_curriculum(self.db,'course-0000'))
        self.assertEqual(actual,expected);self.assertEqual(count,2)
        self.db['assessment_questions'].update({'course_id':'course-0000','set_index':0,'kind':'exam','question_index':0},{'prompt':'Updated prompt'})
        self.db['assessment_questions'].delete({'course_id':'course-0000','set_index':2,'kind':'exercise','exercise_index':1})
        actual=public_curriculum(self.db,'course-0000')
        self.assertEqual(actual[0]['exam'][0][0],'Updated prompt')
        self.assertEqual(actual[2]['exercises'][1]['questions'],[])

    def test_recommendation_ranking_ties_filters_and_query_budget(self):
        db,stamp=self.db,'2026-01-01T00:00:00Z'
        db['departments'].insert({'id':'department','name':'Engineering','created_at':stamp})
        db['candidates'].update({'id':'employee'},{'department_id':'department'})
        db['courses'].update({'id':{'$in':['course-0002','course-0004','course-0009']}},{'title':'A first'})
        db['courses'].update({'id':{'$in':['course-0002','course-0004','course-0009']}},{'department_id':'department'})
        db['courses'].update({'id':{'$in':['course-0003','course-0004','course-0005','course-0006']}},{'category':'Data'})
        db['course_runs'].update({'id':'course-0003-run-9'},{'completed_at':stamp})
        # Courses for another department are never recommended.
        db['departments'].insert({'id':'other','name':'Sales','created_at':stamp})
        db['courses'].update({'id':'course-0007'},{'department_id':'other','visibility':'department','category':'Data'})
        employee=dict(db['candidates'].get('employee'));employee['department']='Engineering'
        progress={('employee','course-0001'):{'completed':False,'started':True},('employee','course-0003'):{'completed':True,'started':True}}
        assigned={('employee','course-0000'):{}}
        actual,count=self.measured(lambda:recommendations(db,employee,progress,assigned))
        self.assertEqual([r['id'] for r in actual],['course-0004','course-0002','course-0009','course-0005','course-0006'])
        self.assertEqual(count,2)
        self.assertEqual(actual[0]['score'],2)
        self.assertEqual(actual[0]['reasons'],['Designed for the Engineering department.','Builds on Data courses you have completed.'])
        all_results=recommendations(db,employee,progress,assigned,limit=None)
        for limit in (0,1,3,6,100,-1):self.assertEqual(recommendations(db,employee,progress,assigned,limit=limit),all_results[:limit])

    def test_activity_stream_preserves_events_and_filters(self):
        stamp='2026-01-01T00:00:00Z'
        self.assertEqual(activity_times(self.db),{'employee':[stamp]*720})
        self.assertEqual(activity_times(self.db,['course-0000']),{'employee':[stamp]*60})
        self.assertEqual(activity_times(self.db,[]),{})


if __name__=='__main__':unittest.main()
