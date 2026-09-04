export type MailSender = {
  configured: boolean;
  send(input: { to: string; subject: string; text: string }): Promise<{ messageId: string }>;
};

export type AgentMailConfig = {
  apiKey: string;
  inbox: string;
};

function inboxPath(inbox: string): string {
  return encodeURIComponent(inbox.trim());
}

export function createAgentMailSender(
  config: AgentMailConfig,
  fetchImpl: typeof fetch = fetch,
): MailSender {
  const apiKey = config.apiKey.trim();
  const inbox = config.inbox.trim();
  const configured = Boolean(apiKey && inbox);

  return {
    configured,
    async send(input) {
      if (!configured) {
        throw new Error('AGENTMAIL_NOT_CONFIGURED');
      }
      const response = await fetchImpl(
        `https://api.agentmail.to/v0/inboxes/${inboxPath(inbox)}/messages/send`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            to: input.to,
            subject: input.subject,
            text: input.text,
          }),
        },
      );
      if (!response.ok) {
        throw new Error(`AGENTMAIL_SEND_FAILED:${response.status}`);
      }
      const body = (await response.json().catch(() => ({}))) as {
        message_id?: string;
        messageId?: string;
      };
      return { messageId: body.messageId ?? body.message_id ?? 'sent' };
    },
  };
}
