export type HandoverId = string; export type SourceId = string; export type TaskId = string; export type Revision = number;
export type TaskState = 'draft' | 'approved' | 'rejected';
export interface Handover { id: HandoverId; title: string; organization: string; createdAt: string; updatedAt: string; sources: Source[]; tasks: Task[]; events: HandoverEvent[]; revision: Revision; }
export interface Source { id: SourceId; title: string; text: string; sha256: string; revision: Revision; }
export interface Citation { sourceId: SourceId; sourceRevision: Revision; quote: string; }
export interface ExportCitation extends Citation { excerptSha256: string; }
export interface Task { id: TaskId; title: string; owner: string | null; dueDate: string | null; state: TaskState; citations: Citation[]; reviewedAt: string | null; provenance: 'manual' | 'deterministic-suggestion' | 'imported'; }
export interface HandoverEvent { id: string; at: string; kind: 'created' | 'edited' | 'reviewed' | 'imported' | 'exported'; detail: string; }
export interface CreateHandoverInput { title: string; organization: string; } export interface HandoverPatch { title?: string; organization?: string; }
export interface CreateSourceInput { title: string; text: string; } export interface SourcePatch { title?: string; text?: string; }
export interface CreateTaskInput { title: string; owner?: string | null; dueDate?: string | null; citations: Citation[]; provenance?: Task['provenance']; }
export interface TaskPatch { title?: string; owner?: string | null; dueDate?: string | null; citations?: Citation[]; }
export interface HandoverSummary { id: HandoverId; title: string; organization: string; updatedAt: string; revision: Revision; }
export interface UnreviewedSuggestion { id: TaskId; title: string; owner: null; dueDate: null; citations: Citation[]; state: 'draft'; reviewedAt: null; provenance: 'deterministic-suggestion'; }
export type GapKind = 'missing-owner' | 'missing-date' | 'missing-citation' | 'unreviewed'; export interface Gap { kind: GapKind; taskId: TaskId | null; message: string; }
export interface ForeignReviewRecord { taskId: TaskId; importedState: TaskState; importedReviewedAt: string | null; }
export interface ForeignSourceRecord { localSourceId: SourceId; originalSourceId: SourceId; originalSourceRevision: Revision; originalSourceSha256: string; excerptSha256: string; }
export interface ExportPacket { format: 'json' | 'markdown'; schemaVersion: 1; handoverId: HandoverId; tasks: Array<Omit<Task, 'citations'> & { citations: ExportCitation[] }>; sources: Array<Pick<Source, 'id' | 'title' | 'sha256' | 'revision'>>; warning: string; }
export interface PrivateBackupPacket { format: 'private-backup-json'; schemaVersion: 1; privateWarning: string; handover: Handover; }
export interface ImportResult { handover: Handover; foreignReview: ReadonlyArray<ForeignReviewRecord>; foreignSources: ReadonlyArray<ForeignSourceRecord>; }
export interface HandoverRepository { createHandover(input: CreateHandoverInput): Promise<Handover>; getHandover(id: HandoverId): Promise<Handover | null>; listHandovers(): Promise<ReadonlyArray<HandoverSummary>>; updateHandover(id: HandoverId, expectedRevision: Revision, patch: HandoverPatch): Promise<Handover>; addSource(id: HandoverId, expectedRevision: Revision, input: CreateSourceInput): Promise<Handover>; updateSource(id: HandoverId, sourceId: SourceId, expectedRevision: Revision, patch: SourcePatch): Promise<Handover>; addTask(id: HandoverId, expectedRevision: Revision, input: CreateTaskInput): Promise<Handover>; updateTask(id: HandoverId, taskId: TaskId, expectedRevision: Revision, patch: TaskPatch): Promise<Handover>; reviewTask(id: HandoverId, taskId: TaskId, expectedRevision: Revision, decision: 'approved' | 'rejected'): Promise<Handover>; deleteHandover(id: HandoverId, expectedRevision: Revision): Promise<void>; deleteSource(id: HandoverId, sourceId: SourceId, expectedRevision: Revision): Promise<Handover>; deleteTask(id: HandoverId, taskId: TaskId, expectedRevision: Revision): Promise<Handover>; }
export interface SuggestionEngine { suggest(source: Source): ReadonlyArray<UnreviewedSuggestion>; }
export interface GapScanner { scan(handover: Handover): ReadonlyArray<Gap>; }
export interface PacketCodec { exportApproved(handover: Handover, format: 'json' | 'markdown', selectedTaskIds?: ReadonlyArray<TaskId>): Promise<ExportPacket>; exportPrivateBackup(handover: Handover): Promise<PrivateBackupPacket>; importPacket(input: ArrayBuffer | string): Promise<ImportResult>; renderPacket(packet: ExportPacket): string; }
