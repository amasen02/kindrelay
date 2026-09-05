export const DB_VERSION = 1;
import type { ForeignReviewRecord, ForeignSourceRecord } from "../domain/types";

export const STORE_HANDOVERS = "handovers";
export const STORE_IMPORT_RECORDS = "importRecords";

export interface ImportRecord {
  handoverId: string;
  foreignReview: ReadonlyArray<ForeignReviewRecord>;
  foreignSources: ReadonlyArray<ForeignSourceRecord>;
}
