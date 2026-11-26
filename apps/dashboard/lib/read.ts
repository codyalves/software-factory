export type Read<T> = { ok: true; value: T } | { ok: false; error: string };

/** A GitHub read that may fail without taking the rest of the page with it. */
export async function read<T>(promise: Promise<T>): Promise<Read<T>> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'unknown error' };
  }
}
