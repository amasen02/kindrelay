import {
  NotFoundError,
  QuotaError,
  RevisionConflictError,
  StorageError,
  ValidationError,
} from "../domain/errors";

export type TransactionControls<T> = {
  succeed(value: T): void;
  fail(error: unknown): void;
};

export function mapStorageError(error: unknown): Error {
  if (
    error instanceof ValidationError ||
    error instanceof RevisionConflictError ||
    error instanceof NotFoundError ||
    error instanceof QuotaError ||
    error instanceof StorageError
  ) {
    return error;
  }
  if (error instanceof DOMException && error.name === "QuotaExceededError") {
    return new QuotaError();
  }
  return new StorageError();
}

/**
 * Schedules IndexedDB work synchronously. Request callbacks may enqueue more
 * requests, but no promise is awaited while the transaction is active.
 */
export function runTransaction<T>(
  db: IDBDatabase,
  stores: readonly string[],
  mode: IDBTransactionMode,
  schedule: (transaction: IDBTransaction, controls: TransactionControls<T>) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let transaction: IDBTransaction;
    let result: T | undefined;
    let succeeded = false;
    let failure: unknown;
    let settled = false;

    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(mapStorageError(error));
    };

    try {
      transaction = db.transaction([...stores], mode);
    } catch (error) {
      rejectOnce(error);
      return;
    }

    const controls: TransactionControls<T> = {
      succeed(value) {
        if (!failure) {
          result = value;
          succeeded = true;
        }
      },
      fail(error) {
        if (failure) return;
        failure = error;
        try {
          transaction.abort();
        } catch {
          // A completed/aborted transaction will report its terminal event.
        }
      },
    };

    transaction.oncomplete = () => {
      if (failure) return rejectOnce(failure);
      if (!succeeded) return rejectOnce(new StorageError());
      if (!settled) {
        settled = true;
        resolve(result as T);
      }
    };
    transaction.onerror = () => rejectOnce(failure ?? transaction.error ?? new StorageError());
    transaction.onabort = () => rejectOnce(failure ?? transaction.error ?? new StorageError());

    try {
      schedule(transaction, controls);
    } catch (error) {
      controls.fail(error);
    }
  });
}

export function failOnRequestError<T>(
  request: IDBRequest<T>,
  fail: (error: unknown) => void,
): IDBRequest<T> {
  request.onerror = () => fail(request.error ?? new StorageError());
  return request;
}
