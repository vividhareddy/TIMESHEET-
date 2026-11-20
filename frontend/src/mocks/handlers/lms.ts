/** LMS catalogue for development mock mode (the real data comes from the LMS's collections, see backend/src/routes/lms.ts). */
import type { CatalogCourse, CourseCatalog } from '@/types/api';
import { route } from '../http';

const COURSES: CatalogCourse[] = [
  { id: 'agile-scrum', title: 'Agile and Scrum', category: 'Professional Development', description: 'Plan, deliver and improve work in short, focused sprints.', difficulty: 'beginner', durationMinutes: 60, lessonCount: 6 },
  { id: 'data-privacy', title: 'Data Privacy and Protection', category: 'Cybersecurity and Data Protection', description: 'Handle personal and client data safely and lawfully.', difficulty: 'beginner', durationMinutes: 60, lessonCount: 7 },
  { id: 'genai-fundamentals', title: 'Generative AI Fundamentals', category: 'Artificial Intelligence', description: 'What large language models can and cannot do at work.', difficulty: 'beginner', durationMinutes: 60, lessonCount: 6 },
  { id: 'java-full-stack', title: 'Java Full Stack Development', category: 'Technical Skills', description: 'Build complete web applications with Java and modern front ends.', difficulty: 'intermediate', durationMinutes: 8250, lessonCount: 40 },
  { id: 'phishing-awareness', title: 'Phishing and Cybersecurity Awareness', category: 'Cybersecurity Awareness', description: 'Spot and report phishing and social-engineering attempts.', difficulty: 'beginner', durationMinutes: 60, lessonCount: 6 },
  { id: 'posh', title: 'POSH', category: 'Policies & Compliance', description: 'Prevention of sexual harassment at the workplace.', difficulty: 'beginner', durationMinutes: 60, lessonCount: 6 },
  { id: 'python-programming', title: 'Python Programming', category: 'Development', description: 'Build a strong foundation in Python, one lesson at a time.', difficulty: 'beginner', durationMinutes: 240, lessonCount: 12 },
  { id: 'python-senior', title: 'Python Programming Senior', category: 'Technical Skills', description: 'Advanced Python patterns, testing and performance.', difficulty: 'advanced', durationMinutes: 500, lessonCount: 18 },
  { id: 'rag', title: 'Retrieval-Augmented Generation (RAG)', category: 'Artificial Intelligence', description: 'Ground AI answers in your own documents.', difficulty: 'intermediate', durationMinutes: 30, lessonCount: 1 },
];

export const lmsRoutes = [route('GET', '/lms/courses', (): CourseCatalog => ({ total: COURSES.length, courses: COURSES }))];
