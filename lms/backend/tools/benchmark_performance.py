"""Repeatable performance fixture in a throwaway MongoDB database (dropped at exit); never touches candidate data.

Queries are counted as MongoDB read commands (each one is a round trip to the server)."""
import argparse
import hashlib
import json
import statistics
import sys
import tempfile
import time
import tracemalloc
import uuid
from pathlib import Path

from pymongo import monitoring

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from database import CURRICULUM, LESSONS, public_curriculum
from admin import admin_action
from analytics import recommendations, activity_times
import store

READ_COMMANDS = {'find', 'aggregate', 'count', 'distinct', 'getMore'}


class ReadCounter(monitoring.CommandListener):
    """Counts read commands while active (the former SQLite trace callback counting SELECT statements)."""
    def __init__(self):
        self.active, self.count = False, 0

    def started(self, event):
        if self.active and event.command_name in READ_COMMANDS:
            self.count += 1

    def succeeded(self, event):
        pass

    def failed(self, event):
        pass


COUNTER = ReadCounter()
monitoring.register(COUNTER)  # Before the first connection, so the MongoDB client reports its commands.


def fixture(count):
    # A path-like target maps to its own throwaway database, dropped when the process exits.
    target = Path(tempfile.gettempdir()) / f'lms-benchmark-{uuid.uuid4().hex}.sqlite3'
    schema = store.connect(target, transactional=False)
    schema.ensure_schema()
    schema.close()
    db = store.connect(target)
    stamp='2026-01-01T00:00:00Z'
    db['candidates'].insert_many([{'id':identity,'full_name':identity,'email':identity+'@example.com','password_hash':'unused-benchmark-hash','created_at':stamp,'updated_at':stamp,'role':role} for identity,role in [('admin','admin'),('employee','employee')]])
    courses,sets,questions,runs,progress=[],[],[],[],[]
    for i in range(count):
        identity=f'course-{i:04}'
        courses.append({'id':identity,'title':f'Course {i:04}','version':1,'status':'published','lessons_json':json.dumps(LESSONS),'sets_json':json.dumps(CURRICULUM),'created_by':'admin'})
        for s,item in enumerate(CURRICULUM):
            sets.append({'course_id':identity,'set_index':s,'title':item['title']})
            for kind,e,group in [('exam',-1,item['exam'])]+[('exercise',e,x['questions']) for e,x in enumerate(item['exercises'])]:
                for j,q in enumerate(group):questions.append({'course_id':identity,'set_index':s,'kind':kind,'exercise_index':e,'question_index':j,'prompt':q[0],'options_json':json.dumps(q[1]),'correct_option':q[2],'explanation':q[3] if len(q)>3 else ''})
        for n in range(10):
            run=f'{identity}-run-{n}'
            runs.append({'id':run,'candidate_id':'employee','course_id':identity,'run_number':n+1,'started_at':stamp,'archived_at':stamp if n<9 else None})
            for video in range(6):progress.append({'run_id':run,'video_index':video,'watched_seconds':40,'completed_at':None,'updated_at':stamp})
    for table,rows in [('courses',courses),('course_sets',sets),('assessment_questions',questions),('course_runs',runs),('video_progress',progress)]:db[table].insert_many(rows)
    db.commit();return db


def measure(db,fn,repeats):
    fn()  # Warm up (connection pool and server caches) before recording.
    COUNTER.count=0;COUNTER.active=True
    tracemalloc.start();result=fn();_,peak=tracemalloc.get_traced_memory();tracemalloc.stop();COUNTER.active=False
    elapsed=[]
    for _ in range(repeats):
        start=time.perf_counter();fn();elapsed.append((time.perf_counter()-start)*1000)
    db.rollback()  # Read-only work: end the transaction so the next measurement starts a fresh one.
    return {'queries':COUNTER.count,'median_ms':round(statistics.median(elapsed),3),'peak_kib':round(peak/1024,1),'output_sha256':hashlib.sha256(json.dumps(result,sort_keys=True).encode()).hexdigest()}


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--courses',type=int,default=100);parser.add_argument('--repeats',type=int,default=7);args=parser.parse_args()
    db=fixture(args.courses)
    try:
        actor=db['candidates'].get('admin')
        employee=dict(db['candidates'].get('employee'));employee['department']=None
        result={'courses':args.courses,'curriculum':measure(db,lambda:public_curriculum(db,'course-0000'),args.repeats),'admin_courses':measure(db,lambda:admin_action(db,actor,'GET','courses',{}),args.repeats),'recommendations':measure(db,lambda:recommendations(db,employee,{},{}),args.repeats),'activity':measure(db,lambda:activity_times(db),args.repeats)}
        print(json.dumps(result,indent=2))
    finally:db.close()


if __name__=='__main__':main()
