export class AppError extends Error {
  constructor(
    public code: string,
    public statusCode = 400,
  ) {
    super(code);
  }
}
