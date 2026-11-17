/**
 * Service layer — the only way the UI reads or writes business data.
 * React UI → services → Axios → Node.js/Express API → PostgreSQL
 * (in mock mode the Axios adapter is replaced by the dev-only mock server in src/mocks).
 */
export { ApiError } from './api';
export { API_MODE, IS_MOCK_MODE } from './config';
export { authService } from './authService';
export { employeeService } from './employeeService';
export { projectService } from './projectService';
export { allocationService } from './allocationService';
export { timesheetService } from './timesheetService';
export { approvalService } from './approvalService';
export { calendarService } from './calendarService';
export { leaveService } from './leaveService';
export { overtimeService } from './overtimeService';
export { reportService } from './reportService';
export { lookupService } from './lookupService';
export { policyDocumentService } from './policyDocumentService';
export { otAssistantService } from './otAssistantService';
export { mockControlService } from './mockControlService';
