export type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; traceId?: string } };

const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";

const REQUEST_TIMEOUT_MS = 30_000;

export async function apiRequest<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timeout = setTimeout(abort, REQUEST_TIMEOUT_MS);
  if (init.signal?.aborted) abort();
  else init.signal?.addEventListener("abort", abort, { once: true });

  try {
    let response: Response;
    try {
      response = await fetch(`${API_URL}${path}`, {
        ...init,
        signal: controller.signal,
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...(init.headers ?? {})
        }
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error("Запрос отменён или превышено время ожидания ответа");
      }
      throw new Error("Нет соединения с сервером. Проверьте сеть и повторите запрос");
    }

    let payload: ApiResponse<T> | null = null;
    try {
      payload = (await response.json()) as ApiResponse<T>;
    } catch {
      throw new Error(
        response.ok
          ? "Сервис вернул некорректный ответ"
          : `Сервис временно недоступен (HTTP ${response.status})`
      );
    }

    if (!payload || typeof payload !== "object" || typeof payload.ok !== "boolean") {
      throw new Error("Сервис вернул некорректный формат ответа");
    }

    if (!response.ok || !payload.ok) {
      if (!payload.ok) {
        throw new Error(payload.error.message || "Запрос не выполнен");
      }
      throw new Error(`Запрос не выполнен (HTTP ${response.status})`);
    }

    return payload.data;
  } finally {
    clearTimeout(timeout);
    init.signal?.removeEventListener("abort", abort);
  }
}
