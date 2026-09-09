export class ArrApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = 'ArrApiError';
  }
}

export class ArrClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string
  ) {}

  private url(pathname: string): string {
    const base = this.baseUrl.replace(/\/+$/, '');
    const path = pathname.startsWith('/') ? pathname : `/${pathname}`;
    return `${base}${path}`;
  }

  async request<T>(
    pathname: string,
    init: RequestInit = {}
  ): Promise<T> {
    if (!this.baseUrl) {
      throw new ArrApiError('Service URL is not configured.');
    }

    if (!this.apiKey) {
      throw new ArrApiError('API key is not configured.');
    }

    let response: Response;

    try {
      response = await fetch(this.url(pathname), {
        ...init,
        signal: AbortSignal.timeout(10_000),
        headers: {
          'X-Api-Key': this.apiKey,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          ...(init.headers || {})
        }
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown network error';

      throw new ArrApiError(
        `Could not connect to service: ${message}`
      );
    }

    if (!response.ok) {
      throw new ArrApiError(
        `Service returned HTTP ${response.status}.`,
        response.status
      );
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const contentType = response.headers.get('content-type') || '';

    if (!contentType.includes('application/json')) {
      throw new ArrApiError(
        'Service returned an unexpected response.'
      );
    }

    return await response.json() as T;
  }

  get<T>(pathname: string): Promise<T> {
    return this.request<T>(pathname);
  }

  post<T>(pathname: string, body: unknown): Promise<T> {
    return this.request<T>(pathname, {
      method: 'POST',
      body: JSON.stringify(body)
    });
  }

  put<T>(pathname: string, body: unknown): Promise<T> {
    return this.request<T>(pathname, {
      method: 'PUT',
      body: JSON.stringify(body)
    });
  }

  delete<T>(pathname: string): Promise<T> {
    return this.request<T>(pathname, {
      method: 'DELETE'
    });
  }
}
