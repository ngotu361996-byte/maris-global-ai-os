/** Standard error body for every /api/v1 endpoint. */
export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}
