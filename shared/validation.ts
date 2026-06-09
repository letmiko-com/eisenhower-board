import { z } from 'zod';

export const QuadrantKeySchema = z.enum([
  'urgentImportant',
  'notUrgentImportant',
  'urgentNotImportant',
  'notUrgentNotImportant',
]);

export const TaskSchema = z.object({
  id: z.string(),
  text: z.string(),
  createdAt: z.number(),
});

export const QuadrantsStateSchema = z.object({
  urgentImportant: z.array(TaskSchema),
  notUrgentImportant: z.array(TaskSchema),
  urgentNotImportant: z.array(TaskSchema),
  notUrgentNotImportant: z.array(TaskSchema),
});

export const CreateTaskRequestSchema = z.object({
  text: z.string().min(1, 'Text is required').max(500, 'Text too long'),
  quadrant: QuadrantKeySchema,
});

export const UpdateTaskRequestSchema = z.object({
  text: z.string().min(1, 'Text cannot be empty').max(500, 'Text too long').optional(),
  quadrant: QuadrantKeySchema.optional(),
}).refine(
  (data) => data.text !== undefined || data.quadrant !== undefined,
  { message: 'At least one field must be provided' }
);

export const MagicLinkRequestSchema = z.object({
  email: z.string().trim().toLowerCase().email('Invalid email'),
  language: z.string().min(2).max(5).optional(),
});

export const TaskIdSchema = z.string().uuid('Invalid task ID');

export const UserIdSchema = z.string().uuid('Invalid user ID');

export const SessionIdSchema = z.string().uuid('Invalid session ID');

export const ChangeEmailRequestSchema = z.object({
  email: z.string().trim().toLowerCase().email('Invalid email'),
  language: z.string().min(2).max(5).optional(),
});

const TaskMoveBatchOperationSchema = z.object({
  type: z.literal('move'),
  id: TaskIdSchema,
  quadrant: QuadrantKeySchema,
});

const TaskEditBatchOperationSchema = z.object({
  type: z.literal('edit'),
  id: TaskIdSchema,
  text: z.string().min(1, 'Text cannot be empty').max(500, 'Text too long'),
});

const TaskDeleteBatchOperationSchema = z.object({
  type: z.literal('delete'),
  id: TaskIdSchema,
});

const TaskCompleteBatchOperationSchema = z.object({
  type: z.literal('complete'),
  id: TaskIdSchema,
});

export const TaskBatchOperationSchema = z.discriminatedUnion('type', [
  TaskMoveBatchOperationSchema,
  TaskEditBatchOperationSchema,
  TaskDeleteBatchOperationSchema,
  TaskCompleteBatchOperationSchema,
]);

export const TaskBatchRequestSchema = z.object({
  operations: z.array(TaskBatchOperationSchema).min(1, 'At least one operation is required').max(100, 'Too many operations'),
});

export const ArchivedTasksQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().max(200, 'Search query too long').optional(),
  quadrant: QuadrantKeySchema.optional(),
  from: z.coerce.number().int().positive().optional(),
  to: z.coerce.number().int().positive().optional(),
});

export type QuadrantKey = z.infer<typeof QuadrantKeySchema>;
export type Task = z.infer<typeof TaskSchema>;
export type QuadrantsState = z.infer<typeof QuadrantsStateSchema>;

export type CreateTaskRequest = z.infer<typeof CreateTaskRequestSchema>;
export type UpdateTaskRequest = z.infer<typeof UpdateTaskRequestSchema>;
export type MagicLinkRequest = z.infer<typeof MagicLinkRequestSchema>;
export type TaskBatchOperation = z.infer<typeof TaskBatchOperationSchema>;
export type TaskBatchRequest = z.infer<typeof TaskBatchRequestSchema>;
export type ArchivedTasksQuery = z.infer<typeof ArchivedTasksQuerySchema>;
