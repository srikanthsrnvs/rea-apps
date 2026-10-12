export class SpotifyError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export class SpotifyConnection {
  constructor(socket, target, timeoutMs = 20000) {
    this.socket = socket;
    this.target = target;
    this.timeoutMs = timeoutMs;
    this.sequence = 0;
    this.pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const request = this.pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer);
      this.pending.delete(message.id);
      if (message.error) request.reject(new SpotifyError("CDP_ERROR", message.error.message));
      else request.resolve(message.result);
    });
    socket.addEventListener("close", () => {
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(
          new SpotifyError("DISCONNECTED", "Spotify closed the debugging connection."),
        );
      }
      this.pending.clear();
    });
  }

  static async connect(port = 9222, timeoutMs = 20000, { allowLogin = false } = {}) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      throw new SpotifyError("INVALID_ARGUMENT", "Port must be an integer between 1024 and 65535.");
    }
    let targets;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      targets = await response.json();
    } catch {
      throw new SpotifyError(
        "NOT_CONNECTED",
        "Spotify runtime is unavailable. Run spotify connect to launch it with local debugging.",
      );
    }
    if (!Array.isArray(targets))
      throw new SpotifyError(
        "INVALID_ENDPOINT",
        "Selected port did not return a debugger target list.",
      );
    const candidates = targets.filter(
      (t) =>
        t?.type === "page" &&
        (/^https:\/\/xpui\.app\.spotify\.com\//.test(t.url) ||
          (allowLogin && /^https:\/\/login\.app\.spotify\.com\//.test(t.url))),
    );
    if (
      !allowLogin &&
      candidates.length === 0 &&
      targets.some((t) => t?.type === "page" && /^https:\/\/login\.app\.spotify\.com\//.test(t.url))
    )
      throw new SpotifyError(
        "LOGIN_REQUIRED",
        "Run spotify login, approve its pairing code on another device, then check login-status.",
      );
    if (candidates.length !== 1)
      throw new SpotifyError("TARGET_UNAVAILABLE", "Expected exactly one Spotify desktop UI.", {
        count: candidates.length,
      });
    const target = candidates[0];
    const endpoint = new URL(target.webSocketDebuggerUrl);
    if (
      endpoint.protocol !== "ws:" ||
      endpoint.hostname !== "127.0.0.1" ||
      Number(endpoint.port) !== port
    ) {
      throw new SpotifyError(
        "INVALID_ENDPOINT",
        "Spotify debugger must be on the selected local port.",
      );
    }
    const socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new SpotifyError("TIMEOUT", "Timed out connecting to Spotify."));
      }, 3000);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new SpotifyError("NOT_CONNECTED", "Could not open Spotify debugger."));
        },
        { once: true },
      );
    });
    return new SpotifyConnection(socket, target, timeoutMs);
  }

  request(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new SpotifyError(
            "TIMEOUT",
            `${method} timed out. The action may have completed; inspect state before retrying.`,
          ),
        );
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new SpotifyError("DISCONNECTED", error.message));
      }
    });
  }

  async evaluate(expression) {
    const response = await this.request("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      throw new SpotifyError(
        "RUNTIME_ERROR",
        response.exceptionDetails.exception?.description ?? response.exceptionDetails.text,
      );
    }
    return response.result.value;
  }

  close() {
    this.socket.close();
  }
}
