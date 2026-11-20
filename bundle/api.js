import { AnnaAppRuntime } from "/static/anna-apps/_sdk/latest/index.js";

const TIMEOUT_MS = 55000;

export class ApiError extends Error {
  constructor(kind, message, retryable, cause = null) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.retryable = retryable;
    this.cause = cause;
  }
}

function detailOf(error) {
  return String(error?.message || error || "");
}

function classify(error) {
  const detail = detailOf(error);
  const code = error?.code ?? error?.data?.code;
  if (detail.includes("Failed to fetch") || detail.includes("NetworkError") || detail.includes("ERR_CONNECTION")) {
    return new ApiError("bridge_unreachable", "Can't reach the app runtime. Check that the dev server is running, then press Retry.", true, error);
  }
  if (code === -32602 || detail.includes("-32602") || detail.includes("unknown session_id")) {
    return new ApiError("session_expired", "Session expired, reconnecting...", true, error);
  }
  if (code === "tool_timeout" || detail.toLowerCase().includes("timeout") || detail.toLowerCase().includes("timed out")) {
    return new ApiError("timeout", "This step took too long. Press Retry to run this step again.", true, error);
  }
  if (code === -32603 || detail.includes("-32603")) {
    return new ApiError("plugin_error", "The study service encountered an error. Press Retry to try this step again.", true, error);
  }
  if (code === -32001 || code === -32008 || /sampling|model|AI unavailable|llm disabled/i.test(detail)) {
    return new ApiError("model_unavailable", "AI mode is unavailable, so StudyLens will use Basic mode.", false, error);
  }
  if (/required|invalid|too long|too short|validation/i.test(detail)) {
    return new ApiError("validation", detail, false, error);
  }
  return new ApiError("bridge_error", "The app runtime could not complete this step. Press Retry to try again.", true, error);
}

export function createApi({ toolId, onStatus, onError }) {
  let anna = null;
  let connected = false;
  let reconnecting = false;

  const setStatus = (value) => {
    connected = value === "connected";
    onStatus?.(value);
  };

  async function connect() {
    try {
      anna = await AnnaAppRuntime.connect();
      await anna.window.ready();
      setStatus("connected");
      return anna;
    } catch (error) {
      setStatus("reconnecting");
      throw classify(error);
    }
  }

  async function reconnect() {
    if (reconnecting) throw new ApiError("bridge_unreachable", "Can't reach the app runtime. Check that the dev server is running, then press Retry.", true);
    reconnecting = true;
    setStatus("reconnecting");
    try {
      return await connect();
    } finally {
      reconnecting = false;
    }
  }

  async function invoke(method, args, { retrySession = true } = {}) {
    if (!anna || !connected) {
      try {
        await connect();
      } catch (error) {
        onError?.(error);
        throw error;
      }
    }
    try {
      const response = await anna.tools.invoke({ tool_id: toolId, method, args, timeoutMs: TIMEOUT_MS });
      const data = response?.data || response?.result?.data || response;
      if (data?.success === false) {
        throw new ApiError("plugin_error", "The study service encountered an error. Press Retry to try this step again.", true);
      }
      return data;
    } catch (error) {
      const classified = error instanceof ApiError ? error : classify(error);
      console.error("StudyLens API error", { method, kind: classified.kind, message: detailOf(error), cause: error });
      onError?.(classified);
      if (classified.kind === "session_expired" && retrySession) {
        try {
          await reconnect();
          return await invoke(method, args, { retrySession: false });
        } catch (reconnectError) {
          throw new ApiError("session_expired", "Session expired. Please reload the page.", false, reconnectError);
        }
      }
      throw classified;
    }
  }

  async function health() {
    try {
      const result = await invoke("health", {}, { retrySession: false });
      return {
        connected: true,
        status: result?.status || "unknown",
        modelAvailable: result?.modelAvailable === true,
      };
    } catch (error) {
      return { connected: false, status: "service-unavailable", modelAvailable: false, error };
    }
  }

  return {
    connect,
    reconnect,
    invoke,
    health,
    setTitle: async (title) => {
      if (!anna) await connect();
      return anna.window.set_title({ title });
    },
    storageSet: async (value) => {
      if (!anna) await connect();
      return anna.storage.set(value);
    },
    storageGet: async (value) => {
      if (!anna) await connect();
      return anna.storage.get(value);
    },
    isConnected: () => connected,
  };
}
