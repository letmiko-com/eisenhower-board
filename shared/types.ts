export type QuadrantKey =
  | 'urgentImportant'
  | 'notUrgentImportant'
  | 'urgentNotImportant'
  | 'notUrgentNotImportant';

export interface Task {
  id: string;
  text: string;
  createdAt: number;
  // Optional for backwards compatibility with tasks created before the column
  // existed in client-side state; the server always sends it.
  updatedAt?: number;
  dueAt?: number;
  completedAt?: number;
}

export interface ArchivedTask extends Task {
  completedAt: number;
  quadrant: QuadrantKey;
}

export type QuadrantsState = Record<QuadrantKey, Task[]>;

export interface CreateTaskRequest {
  text: string;
  quadrant: QuadrantKey;
  dueAt?: number | null;
}

export interface UpdateTaskRequest {
  text?: string;
  quadrant?: QuadrantKey;
  dueAt?: number | null;
}

export interface MoveTaskBatchOperation {
  type: 'move';
  id: string;
  quadrant: QuadrantKey;
}

export interface EditTaskBatchOperation {
  type: 'edit';
  id: string;
  text: string;
}

export interface DeleteTaskBatchOperation {
  type: 'delete';
  id: string;
}

export interface CompleteTaskBatchOperation {
  type: 'complete';
  id: string;
}

export interface DueTaskBatchOperation {
  type: 'due';
  id: string;
  dueAt: number | null;
}

export type TaskBatchOperation =
  | MoveTaskBatchOperation
  | EditTaskBatchOperation
  | DeleteTaskBatchOperation
  | CompleteTaskBatchOperation
  | DueTaskBatchOperation;

export interface TaskBatchRequest {
  operations: TaskBatchOperation[];
}

export interface ArchivedTasksFilters {
  q?: string;
  quadrant?: QuadrantKey;
  from?: number;
  to?: number;
}

export const QUADRANT_KEYS: QuadrantKey[] = [
  'urgentImportant',
  'notUrgentImportant',
  'urgentNotImportant',
  'notUrgentNotImportant',
];
