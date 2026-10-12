import { env } from '../../config/env.js';

export interface AuthEmailSender {
  sendVerification(to: string, token: string): Promise<void>;
  sendPasswordReset(to: string, token: string): Promise<void>;
}

interface EmailContent {
  to: string;
  subject: string;
  text: string;
  html: string;
}

async function sendEmail(content: EmailContent): Promise<void> {
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_EMAIL_API_TOKEN || !env.AUTH_EMAIL_FROM) {
    return;
  }

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/email/sending/send`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.CLOUDFLARE_EMAIL_API_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        to: content.to,
        from: {
          address: env.AUTH_EMAIL_FROM,
          name: env.AUTH_EMAIL_FROM_NAME ?? 'AINovel',
        },
        subject: content.subject,
        html: content.html,
        text: content.text,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`Authentication email delivery failed (${String(response.status)})`);
  }
}

function link(baseUrl: string | undefined, token: string): string {
  if (!baseUrl) return token;
  const url = new URL(baseUrl);
  url.searchParams.set('token', token);
  return url.toString();
}

export function createAuthEmailSender(): AuthEmailSender {
  return {
    async sendVerification(to, token) {
      const verificationLink = link(env.AUTH_EMAIL_VERIFY_URL, token);
      await sendEmail({
        to,
        subject: 'Verify your AINovel email',
        text: `Verify your email: ${verificationLink}`,
        html: `<p>Verify your AINovel email:</p><p><a href="${verificationLink}">Verify email</a></p>`,
      });
    },
    async sendPasswordReset(to, token) {
      const resetLink = link(env.AUTH_PASSWORD_RESET_URL, token);
      await sendEmail({
        to,
        subject: 'Reset your AINovel password',
        text: `Reset your password: ${resetLink}\n\nThis link expires in one hour.`,
        html: `<p>Reset your AINovel password:</p><p><a href="${resetLink}">Reset password</a></p><p>This link expires in one hour.</p>`,
      });
    },
  };
}
