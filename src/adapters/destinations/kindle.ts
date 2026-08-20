import nodemailer from 'nodemailer';

export interface KindleMail {
  from: string;
  to: string;
  subject: string;
  filename: string;
  content: Uint8Array;
  contentType: string;
}

export interface KindleMailTransport {
  send(mail: KindleMail, signal?: AbortSignal): Promise<void>;
}

export interface SmtpSettings {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
}

export class NodemailerKindleTransport implements KindleMailTransport {
  private readonly settings: SmtpSettings;

  constructor(settings: SmtpSettings) {
    this.settings = settings;
  }

  async send(mail: KindleMail, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const transporter = nodemailer.createTransport({
      host: this.settings.host,
      port: this.settings.port,
      secure: this.settings.secure,
      auth: { user: this.settings.user, pass: this.settings.password },
    });
    try {
      await transporter.sendMail({
        from: mail.from,
        to: mail.to,
        subject: mail.subject,
        text: 'Sent by Pi Reads after interactive confirmation.',
        attachments: [{
          filename: mail.filename,
          content: Buffer.from(mail.content),
          contentType: mail.contentType,
        }],
      });
    } catch {
      throw new Error('Kindle SMTP delivery failed');
    } finally {
      transporter.close();
    }
  }
}

export function redactEmail(value: string): string {
  const at = value.lastIndexOf('@');
  if (at <= 0) return '[redacted]';
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  return `${local.slice(0, 1)}${'*'.repeat(Math.min(Math.max(local.length - 1, 3), 8))}@${domain}`;
}
