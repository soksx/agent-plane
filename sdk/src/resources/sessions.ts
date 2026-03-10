import type { AgentPlane } from "../client";
import type {
  Session,
  SessionWithRuns,
  CreateSessionParams,
  SendMessageParams,
  ListSessionsParams,
  PaginatedResponse,
  StreamEvent,
} from "../types";
import { narrowStreamEvent } from "../types";
import { RunStream, parseNdjsonStream } from "../streaming";

export class SessionsResource {
  constructor(private readonly _client: AgentPlane) {}

  /**
   * Create a new session for an agent.
   *
   * If `prompt` is provided, the first message is sent immediately and a
   * `RunStream` is returned (same as `sendMessage`).
   *
   * If no `prompt`, returns the session object in idle state.
   */
  async create(
    params: CreateSessionParams,
    options?: { signal?: AbortSignal },
  ): Promise<Session | RunStream> {
    if (!params.prompt) {
      return this._client._request<Session>("POST", "/api/sessions", { body: params });
    }

    const streamOpts: { body: unknown; signal?: AbortSignal } = { body: params };
    if (options?.signal) streamOpts.signal = options.signal;

    const response = await this._client._requestStream("POST", "/api/sessions", streamOpts);

    const runStreamOpts: import("../streaming").RunStreamOptions = {};
    if (options?.signal) runStreamOpts.signal = options.signal;

    return new RunStream(response, runStreamOpts);
  }

  /** Get a session by ID, including linked runs (message history). */
  async get(sessionId: string): Promise<SessionWithRuns> {
    return this._client._request<SessionWithRuns>("GET", `/api/sessions/${sessionId}`);
  }

  /** List sessions with optional filtering. */
  async list(params?: ListSessionsParams): Promise<PaginatedResponse<Session>> {
    const query: Record<string, string | number | undefined> = {
      limit: params?.limit,
      offset: params?.offset,
      agent_id: params?.agent_id,
      status: params?.status,
    };

    const response = await this._client._request<{ data: Session[]; limit: number; offset: number }>(
      "GET",
      "/api/sessions",
      { query },
    );

    return {
      ...response,
      has_more: response.data.length === response.limit,
    };
  }

  /**
   * Send a message to a session.
   *
   * Returns a `RunStream` (async iterable of `StreamEvent`).
   */
  async sendMessage(
    sessionId: string,
    params: SendMessageParams,
    options?: { signal?: AbortSignal },
  ): Promise<RunStream> {
    const streamOpts: { body: unknown; signal?: AbortSignal } = { body: params };
    if (options?.signal) streamOpts.signal = options.signal;

    const response = await this._client._requestStream(
      "POST",
      `/api/sessions/${sessionId}/messages`,
      streamOpts,
    );

    const runStreamOpts: import("../streaming").RunStreamOptions = {};
    if (options?.signal) runStreamOpts.signal = options.signal;

    return new RunStream(response, runStreamOpts);
  }

  /**
   * Send a message and wait for the complete response.
   *
   * Returns the final text content from the assistant's response.
   */
  async sendMessageAndWait(
    sessionId: string,
    params: SendMessageParams,
    options?: { signal?: AbortSignal; timeout_ms?: number },
  ): Promise<{ text: string; events: StreamEvent[] }> {
    const timeoutMs = options?.timeout_ms ?? 10 * 60 * 1000;

    let signal = options?.signal;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    if (!signal) {
      const controller = new AbortController();
      signal = controller.signal;
      timeoutId = setTimeout(() => controller.abort(new Error("Timeout")), timeoutMs);
    }

    try {
      const stream = await this.sendMessage(sessionId, params, { signal });
      const events: StreamEvent[] = [];
      let text = "";

      for await (const event of stream) {
        events.push(event);
        if (event.type === "text_delta") {
          text += event.text;
        }
      }

      return { text, events };
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  }

  /**
   * Stop a session.
   *
   * Backs up session file, stops sandbox, marks session as stopped.
   */
  async stop(sessionId: string): Promise<Session> {
    return this._client._request<Session>("DELETE", `/api/sessions/${sessionId}`);
  }
}
