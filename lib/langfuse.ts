import Langfuse from "langfuse";

type JsonRecord = Record<string, unknown>;

type SafeObservation = {
  id: string | null;
  end: (payload?: JsonRecord) => void;
  update: (payload: JsonRecord) => void;
};

let langfuseClient: Langfuse | null | undefined;

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getClient(): Langfuse | null {
  if (langfuseClient !== undefined) {
    return langfuseClient;
  }

  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const baseUrl = process.env.LANGFUSE_HOST ?? "https://cloud.langfuse.com";

  if (!publicKey || !secretKey) {
    langfuseClient = null;
    return langfuseClient;
  }

  try {
    langfuseClient = new Langfuse({
      publicKey,
      secretKey,
      baseUrl,
    });
    return langfuseClient;
  } catch {
    langfuseClient = null;
    return langfuseClient;
  }
}

function noopObservation(): SafeObservation {
  return {
    id: null,
    end: () => undefined,
    update: () => undefined,
  };
}

export function safeStartTrace(params: {
  traceId?: string;
  name: string;
  input?: unknown;
  metadata?: JsonRecord;
  sessionId?: string;
  userId?: string;
}): { traceId: string | null } {
  const client = getClient();
  if (!client) {
    return { traceId: params.traceId ?? null };
  }

  try {
    const trace = client.trace({
      id: params.traceId,
      name: params.name,
      input: params.input,
      metadata: params.metadata,
      sessionId: params.sessionId,
      userId: params.userId,
    });
    return { traceId: trace.id };
  } catch {
    return { traceId: params.traceId ?? null };
  }
}

export function safeUpdateTrace(
  traceId: string | null | undefined,
  payload: {
    output?: unknown;
    metadata?: JsonRecord;
    tags?: string[];
    level?: "DEFAULT" | "DEBUG" | "WARNING" | "ERROR";
    statusMessage?: string;
  },
): void {
  if (!traceId) {
    return;
  }
  const client = getClient();
  if (!client) {
    return;
  }

  try {
    client.trace({ id: traceId }).update(payload);
  } catch {
    // fail-safe: never throw into app path
  }
}

export function safeStartSpan(params: {
  traceId?: string | null;
  parentObservationId?: string | null;
  name: string;
  input?: unknown;
  metadata?: JsonRecord;
}): SafeObservation {
  const client = getClient();
  if (!client || !params.traceId) {
    return noopObservation();
  }

  try {
    const span = client.span({
      traceId: params.traceId,
      parentObservationId: params.parentObservationId ?? undefined,
      name: params.name,
      input: params.input,
      metadata: params.metadata,
    });

    return {
      id: span.id,
      end: (payload) => {
        try {
          span.end(payload);
        } catch {
          // fail-safe
        }
      },
      update: (payload) => {
        try {
          span.update(payload);
        } catch {
          // fail-safe
        }
      },
    };
  } catch {
    return noopObservation();
  }
}

export function safeStartGeneration(params: {
  traceId?: string | null;
  parentObservationId?: string | null;
  name: string;
  model: string;
  input?: unknown;
  metadata?: JsonRecord;
}): SafeObservation {
  const client = getClient();
  if (!client || !params.traceId) {
    return noopObservation();
  }

  try {
    const generation = client.generation({
      traceId: params.traceId,
      parentObservationId: params.parentObservationId ?? undefined,
      name: params.name,
      model: params.model,
      input: params.input,
      metadata: params.metadata,
    });

    return {
      id: generation.id,
      end: (payload) => {
        try {
          generation.end(payload);
        } catch {
          // fail-safe
        }
      },
      update: (payload) => {
        try {
          generation.update(payload);
        } catch {
          // fail-safe
        }
      },
    };
  } catch {
    return noopObservation();
  }
}

export async function safeShutdownLangfuse(): Promise<void> {
  const client = getClient();
  if (!client) {
    return;
  }
  try {
    await client.shutdownAsync();
  } catch {
    // fail-safe
  }
}

export async function safeFlushLangfuse(): Promise<void> {
  const client = getClient();
  if (!client) {
    return;
  }
  try {
    await client.flushAsync();
  } catch {
    // fail-safe
  }
}

export function safeCaptureLangfuseErrorContext(params: {
  traceId?: string | null;
  location: string;
  error: unknown;
}): void {
  safeUpdateTrace(params.traceId ?? null, {
    level: "WARNING",
    statusMessage: `[Langfuse-safe] ${params.location}: ${toErrorMessage(params.error)}`,
  });
}
