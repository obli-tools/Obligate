import rateLimit from 'express-rate-limit';

export const apiLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 500,
  skip: (req) => !!req.session?.userId,
  standardHeaders: true,
  legacyHeaders: false,
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  keyGenerator: (req) => {
    const ip = req.ip || 'unknown';
    const username = (req.body as { username?: string })?.username || '';
    return `${ip}:${username}`;
  },
  standardHeaders: true,
  legacyHeaders: false,
});
