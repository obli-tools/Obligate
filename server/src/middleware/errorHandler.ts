import type { Request, Response, NextFunction } from 'express';
import { AppError } from './auth';
import { logger } from '../utils/logger';

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ success: false, error: err.message });
    return;
  }

  logger.error(err, 'Unhandled error');
  res.status(500).json({ success: false, error: 'Internal server error' });
}
