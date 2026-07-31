export class AppError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details?: string
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export function toPublicError(error: unknown): Error {
  if (error instanceof AppError) {
    return new Error(`${error.code}: ${error.message}`)
  }

  if (error instanceof Error) {
    return new Error(error.message)
  }

  return new Error('Something unexpected happened.')
}
