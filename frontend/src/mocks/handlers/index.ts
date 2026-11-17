import { authRoutes } from './auth';
import { coreRoutes } from './core';
import { workflowRoutes } from './workflow';
import { reportRoutes } from './reports';
import { policyDocumentRoutes } from './policyDocuments';

/** Order matters: specific paths (e.g. /timesheets/me/draft) are listed before /timesheets/:id. */
export const routes = [...authRoutes, ...coreRoutes, ...workflowRoutes, ...reportRoutes, ...policyDocumentRoutes];
