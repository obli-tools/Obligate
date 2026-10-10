import nodemailer from 'nodemailer';

export interface SmtpConfig {
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  smtpFrom: string;
  smtpTls: boolean;
}

/**
 * Send a plain-text test email using the provided SMTP config.
 * Used by the admin Settings page's "Test" button to validate credentials
 * without persisting them. Throws on any transport / send failure — the
 * caller renders the error message to the admin.
 */
export const mailService = {
  async sendTest(config: SmtpConfig, to: string, senderName: string): Promise<{ messageId: string; accepted: number }> {
    if (!config.smtpHost) throw new Error('SMTP host is empty');
    if (!config.smtpFrom) throw new Error('SMTP "From" address is empty');
    if (!to) throw new Error('Recipient address is required');

    const transporter = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort || 587,
      secure: config.smtpPort === 465, // implicit TLS on 465 only
      requireTLS: config.smtpTls && config.smtpPort !== 465,
      auth: config.smtpUser
        ? { user: config.smtpUser, pass: config.smtpPass }
        : undefined,
      // Fail fast — admin is waiting on this response.
      connectionTimeout: 8000,
      greetingTimeout: 8000,
      socketTimeout: 8000,
    });

    // verify() catches auth / TLS / network issues with a clear message
    // before we spend more time on the send.
    await transporter.verify();

    const info = await transporter.sendMail({
      from: config.smtpFrom,
      to,
      subject: 'Obligate — SMTP test',
      text:
        `Hello ${senderName},\n\n` +
        `This is a test email sent from your Obligate instance to verify that ` +
        `the SMTP settings work.\n\n` +
        `If you're reading this, your SMTP configuration is correct.\n\n` +
        `— Obligate\n`,
    });

    return {
      messageId: info.messageId,
      accepted: Array.isArray(info.accepted) ? info.accepted.length : 0,
    };
  },

  /**
   * Plain-text mail with the SAVED SMTP settings (operational alerts). Returns
   * false, without throwing, when SMTP is not configured or there is no
   * recipient; throws on a transport failure.
   */
  async send(to: string[], subject: string, text: string): Promise<boolean> {
    const recipients = to.map((s) => s.trim()).filter(Boolean);
    if (recipients.length === 0) return false;
    const { configService } = await import('./config.service');
    const cfg = await configService.getAll();
    if (!cfg.smtpHost || !cfg.smtpFrom) return false;
    const transporter = nodemailer.createTransport({
      host: cfg.smtpHost,
      port: cfg.smtpPort || 587,
      secure: cfg.smtpPort === 465,
      requireTLS: cfg.smtpTls && cfg.smtpPort !== 465,
      auth: cfg.smtpUser ? { user: cfg.smtpUser, pass: cfg.smtpPass } : undefined,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
    });
    await transporter.sendMail({ from: cfg.smtpFrom, to: recipients.join(', '), subject, text });
    return true;
  },
};
